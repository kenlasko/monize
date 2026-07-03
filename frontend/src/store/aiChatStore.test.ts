import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  useAiChatStore,
  AI_CHAT_STORAGE_KEY,
} from './aiChatStore';
import type { StreamCallbacks } from '@/types/ai';

let capturedCallbacks: StreamCallbacks | null = null;
const mockAbortController = { abort: vi.fn() };

const mockConfirmAction = vi.fn();
const mockGetRelayResponse = vi.fn();
const mockNotifyAiAction = vi.fn();

vi.mock('@/lib/ai', () => ({
  aiApi: {
    queryStream: vi.fn((_query: string, callbacks: StreamCallbacks) => {
      capturedCallbacks = callbacks;
      return mockAbortController;
    }),
    confirmAction: (...args: unknown[]) => mockConfirmAction(...args),
    getRelayResponse: (...args: unknown[]) => mockGetRelayResponse(...args),
  },
}));

vi.mock('@/lib/aiActionSignal', () => ({
  notifyAiAction: () => mockNotifyAiAction(),
}));

// The error / onError / onDone handlers attempt a relay pickup before
// surfacing an error, so the final state is settled in a microtask. Drain it.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('aiChatStore', () => {
  beforeEach(() => {
    // Stop any relay late-answer poll left running by a previous test before
    // resetting, so its interval can't fire into the next test's mocks.
    useAiChatStore.getState()._relayPollCancel?.();
    vi.clearAllMocks();
    capturedCallbacks = null;
    window.localStorage.removeItem(AI_CHAT_STORAGE_KEY);
    useAiChatStore.setState({
      messages: [],
      isLoading: false,
      thinking: { active: false, message: '', liveText: '', tools: [] },
      _abortController: null,
      _activeAssistantId: null,
      _relayPollCancel: null,
    });
  });

  describe('submit', () => {
    it('appends a user message and enters loading state', () => {
      useAiChatStore.getState().submit('What is my balance?');

      const state = useAiChatStore.getState();
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0]).toMatchObject({
        role: 'user',
        content: 'What is my balance?',
      });
      expect(state.isLoading).toBe(true);
      expect(state.thinking.active).toBe(true);
    });

    it('sends the attachment payload and stores only metadata (no base64)', async () => {
      const { aiApi } = await import('@/lib/ai');
      const attachments = [
        { kind: 'image' as const, mediaType: 'image/png', filename: 'r.png', data: 'SECRETB64' },
      ];

      useAiChatStore.getState().submit('extract this', attachments);

      // The persisted message keeps metadata only -- no base64 payload.
      const userMsg = useAiChatStore.getState().messages[0];
      expect(userMsg.attachments).toEqual([
        { kind: 'image', mediaType: 'image/png', filename: 'r.png' },
      ]);
      expect(JSON.stringify(userMsg)).not.toContain('SECRETB64');

      const persisted = window.localStorage.getItem(AI_CHAT_STORAGE_KEY) || '';
      expect(persisted).toContain('r.png');
      expect(persisted).not.toContain('SECRETB64');

      // The full payload is handed to the API client as the 5th argument.
      const call = vi.mocked(aiApi.queryStream).mock.calls[0];
      expect(call[4]).toEqual(attachments);
    });

    it('does not resend attachments in conversation history on later turns', async () => {
      const { aiApi } = await import('@/lib/ai');

      useAiChatStore.getState().submit('first', [
        { kind: 'image' as const, mediaType: 'image/png', filename: 'r.png', data: 'SECRETB64' },
      ]);
      // Complete the assistant turn so it becomes part of history.
      capturedCallbacks?.onEvent({ type: 'content', text: 'done' });
      capturedCallbacks?.onEvent({
        type: 'done',
        usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
      });

      useAiChatStore.getState().submit('second');

      const history = vi.mocked(aiApi.queryStream).mock.calls[1][2];
      const serialized = JSON.stringify(history);
      expect(serialized).not.toContain('SECRETB64');
      expect(serialized).not.toContain('r.png');
    });

    it('caps conversation history in relay mode to the most recent turns', async () => {
      const { aiApi } = await import('@/lib/ai');
      // A long prior conversation: relay must not ship all of it to the agent.
      const seeded = Array.from({ length: 24 }, (_, i) => ({
        id: `seed-${i}`,
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `seeded turn ${i}`,
      }));
      useAiChatStore.setState({ messages: seeded });

      useAiChatStore.getState().submit('newest question', undefined, {
        relay: true,
      });

      const history = vi.mocked(aiApi.queryStream).mock.calls[0][2] as Array<{
        role: string;
        content: string;
      }>;
      expect(history.length).toBeLessThanOrEqual(10);
      const serialized = JSON.stringify(history);
      expect(serialized).not.toContain('seeded turn 0');
      expect(serialized).toContain('newest question');
    });

    it('keeps the full conversation history on the native (non-relay) path', async () => {
      const { aiApi } = await import('@/lib/ai');
      const seeded = Array.from({ length: 24 }, (_, i) => ({
        id: `seed-${i}`,
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `seeded turn ${i}`,
      }));
      useAiChatStore.setState({ messages: seeded });

      useAiChatStore.getState().submit('newest question');

      const history = vi.mocked(aiApi.queryStream).mock.calls[0][2] as Array<{
        role: string;
        content: string;
      }>;
      // 24 seeded + the new user turn, untrimmed.
      expect(history.length).toBe(25);
      expect(JSON.stringify(history)).toContain('seeded turn 0');
    });

    it('ignores empty/whitespace queries', async () => {
      const { aiApi } = await import('@/lib/ai');
      useAiChatStore.getState().submit('   ');
      expect(aiApi.queryStream).not.toHaveBeenCalled();
      expect(useAiChatStore.getState().messages).toHaveLength(0);
    });

    it('ignores submission while another query is in flight', async () => {
      const { aiApi } = await import('@/lib/ai');
      useAiChatStore.getState().submit('first');
      useAiChatStore.getState().submit('second');

      expect(aiApi.queryStream).toHaveBeenCalledTimes(1);
      expect(useAiChatStore.getState().messages).toHaveLength(1);
    });

    it('writes streamed content into the assistant message', () => {
      useAiChatStore.getState().submit('Q');

      capturedCallbacks?.onEvent({ type: 'content', text: 'Answer.' });
      capturedCallbacks?.onEvent({
        type: 'done',
        usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
      });

      const messages = useAiChatStore.getState().messages;
      expect(messages).toHaveLength(2);
      expect(messages[1]).toMatchObject({
        role: 'assistant',
        content: 'Answer.',
        isStreaming: false,
      });
      expect(useAiChatStore.getState().isLoading).toBe(false);
    });

    it('records errors against the assistant message', async () => {
      useAiChatStore.getState().submit('Q');

      capturedCallbacks?.onEvent({
        type: 'error',
        message: 'Provider unavailable',
      });
      await flush();

      const messages = useAiChatStore.getState().messages;
      expect(messages).toHaveLength(2);
      expect(messages[1]).toMatchObject({
        role: 'assistant',
        error: 'Provider unavailable',
      });
      expect(useAiChatStore.getState().isLoading).toBe(false);
      // No relay promptId was seen, so pickup must not be attempted.
      expect(mockGetRelayResponse).not.toHaveBeenCalled();
    });
  });

  describe('relay late-answer pickup', () => {
    it('renders a buffered late answer instead of an error after a relay timeout', async () => {
      mockGetRelayResponse.mockResolvedValueOnce({ text: 'The late answer.' });
      useAiChatStore.getState().submit('Q', undefined, { relay: true });

      // The backend tells the client its promptId up front, then the stream
      // times out before any content arrives.
      capturedCallbacks?.onEvent({ type: 'prompt_id', promptId: 'p-1' });
      capturedCallbacks?.onEvent({ type: 'error', message: 'went quiet' });
      await flush();

      expect(mockGetRelayResponse).toHaveBeenCalledWith('p-1');
      const messages = useAiChatStore.getState().messages;
      expect(messages).toHaveLength(2);
      expect(messages[1]).toMatchObject({
        role: 'assistant',
        content: 'The late answer.',
      });
      expect(messages[1].error).toBeUndefined();
      expect(useAiChatStore.getState().isLoading).toBe(false);
    });

    it('falls back to the error when no late answer is buffered', async () => {
      mockGetRelayResponse.mockResolvedValueOnce({ text: null });
      useAiChatStore.getState().submit('Q', undefined, { relay: true });

      capturedCallbacks?.onEvent({ type: 'prompt_id', promptId: 'p-2' });
      capturedCallbacks?.onEvent({ type: 'error', message: 'went quiet' });
      await flush();

      expect(mockGetRelayResponse).toHaveBeenCalledWith('p-2');
      const messages = useAiChatStore.getState().messages;
      expect(messages[1]).toMatchObject({
        role: 'assistant',
        error: 'went quiet',
      });
    });

    it('picks up a late answer when the stream closes without a done event', async () => {
      mockGetRelayResponse.mockResolvedValueOnce({ text: 'Recovered.' });
      useAiChatStore.getState().submit('Q', undefined, { relay: true });

      capturedCallbacks?.onEvent({ type: 'prompt_id', promptId: 'p-3' });
      // Stream closes (onDone) with nothing rendered.
      capturedCallbacks?.onDone?.();
      await flush();

      expect(mockGetRelayResponse).toHaveBeenCalledWith('p-3');
      const messages = useAiChatStore.getState().messages;
      expect(messages[1]).toMatchObject({
        role: 'assistant',
        content: 'Recovered.',
      });
    });

    it('keeps polling and renders an answer that arrives after the first empty pickup', async () => {
      // Reproduces the production failure: at disconnect the answer is not yet
      // buffered (first pickup empty); the agent reconnects and posts a moment
      // later, so a later poll must catch it.
      vi.useFakeTimers();
      try {
        mockGetRelayResponse
          .mockResolvedValueOnce({ text: null })
          .mockResolvedValueOnce({ text: 'Arrived late.' });
        useAiChatStore.getState().submit('Q', undefined, { relay: true });

        capturedCallbacks?.onEvent({ type: 'prompt_id', promptId: 'p-late' });
        capturedCallbacks?.onEvent({ type: 'error', message: 'went quiet' });

        // First (immediate) poll comes back empty -> placeholder shown, still polling.
        await vi.advanceTimersByTimeAsync(0);
        expect(mockGetRelayResponse).toHaveBeenCalledTimes(1);
        expect(useAiChatStore.getState().messages[1]).toMatchObject({
          error: 'went quiet',
        });

        // After the poll interval the answer is buffered and gets picked up.
        await vi.advanceTimersByTimeAsync(4000);
        expect(mockGetRelayResponse).toHaveBeenCalledTimes(2);
        const message = useAiChatStore.getState().messages[1];
        expect(message.content).toBe('Arrived late.');
        expect(message.error).toBeUndefined();
        expect(useAiChatStore.getState().isLoading).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('renders a confirmation card delivered via pickup after the stream gave up', async () => {
      // #793: the agent composed a large write slowly, the turn idle-timed-out,
      // and the card was buffered. The pickup must surface it (then the answer).
      vi.useFakeTimers();
      try {
        const card = {
          actionId: 'act-late',
          type: 'create_transaction',
          preview: {},
          descriptor: { type: 'create_transaction' },
          signature: 'sig',
          expiresAt: Date.now() + 60000,
        };
        mockGetRelayResponse
          .mockResolvedValueOnce({ text: null, pendingActions: [card] })
          .mockResolvedValueOnce({
            text: 'Card ready to review.',
            pendingActions: [],
          });
        useAiChatStore.getState().submit('Bulk edit', undefined, { relay: true });

        capturedCallbacks?.onEvent({ type: 'prompt_id', promptId: 'p-card' });
        capturedCallbacks?.onEvent({ type: 'error', message: 'went quiet' });

        // First pickup returns the buffered card (no answer yet): the card shows
        // and the disconnect placeholder is cleared.
        await vi.advanceTimersByTimeAsync(0);
        let message = useAiChatStore.getState().messages[1];
        expect(message.pendingActions).toHaveLength(1);
        expect(message.pendingActions![0]).toMatchObject({
          actionId: 'act-late',
          status: 'pending',
        });
        expect(message.error).toBeUndefined();

        // The answer arrives on a later poll; the card is preserved alongside it.
        await vi.advanceTimersByTimeAsync(4000);
        message = useAiChatStore.getState().messages[1];
        expect(message.content).toBe('Card ready to review.');
        expect(message.pendingActions).toHaveLength(1);
        expect(useAiChatStore.getState().isLoading).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps a card delivered live before the disconnect, then recovers the answer', async () => {
      // The agent posted confirmation cards (delivered live to the stream) while
      // composing a large final answer; the turn then idle-timed-out before
      // post_response. The live cards must survive the disconnect placeholder and
      // the buffered answer is picked up after, with the cards preserved.
      vi.useFakeTimers();
      try {
        const card = {
          actionId: 'act-live',
          type: 'create_investment_transaction' as const,
          preview: {},
          descriptor: { type: 'create_investment_transaction' as const },
          signature: 'sig',
          expiresAt: Date.now() + 60000,
        };
        mockGetRelayResponse
          .mockResolvedValueOnce({ text: null, pendingActions: [] })
          .mockResolvedValueOnce({ text: 'Done -- review the card.', pendingActions: [] });
        useAiChatStore.getState().submit('Add it', undefined, { relay: true });

        capturedCallbacks?.onEvent({ type: 'prompt_id', promptId: 'p-live' });
        // Card arrives live (no text content yet), then the stream gives up.
        capturedCallbacks?.onEvent({ type: 'pending_action', action: card });
        let message = useAiChatStore.getState().messages[1];
        expect(message.pendingActions).toHaveLength(1);

        capturedCallbacks?.onEvent({ type: 'error', message: 'went quiet' });
        // Placeholder shows, but the live card is not wiped.
        message = useAiChatStore.getState().messages[1];
        expect(message.error).toBe('went quiet');
        expect(message.pendingActions).toHaveLength(1);
        expect(message.pendingActions![0]).toMatchObject({ actionId: 'act-live' });

        // The buffered answer arrives on a later poll; the card is preserved and
        // the placeholder error is cleared.
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(4000);
        message = useAiChatStore.getState().messages[1];
        expect(message.content).toBe('Done -- review the card.');
        expect(message.error).toBeUndefined();
        expect(message.pendingActions).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps polling past the base deadline while new cards keep arriving', async () => {
      // A large import streams confirmation cards over several minutes (one card
      // per ~25 rows). Each new card must push the pickup deadline forward, so an
      // agent still actively delivering is not abandoned mid-import. Without the
      // extension the loop would give up at the base deadline (~135 polls) and the
      // final answer (arriving later) would be lost.
      vi.useFakeTimers();
      try {
        let call = 0;
        mockGetRelayResponse.mockImplementation(() => {
          call += 1;
          if (call <= 150) {
            return Promise.resolve({
              text: null,
              pendingActions: [
                {
                  actionId: `act-${call}`,
                  type: 'create_transaction' as const,
                  preview: {},
                  descriptor: { type: 'create_transaction' as const },
                  signature: 's',
                  expiresAt: Date.now() + 600000,
                },
              ],
            });
          }
          return Promise.resolve({ text: 'All imported.', pendingActions: [] });
        });
        useAiChatStore.getState().submit('Import CSV', undefined, { relay: true });
        capturedCallbacks?.onEvent({ type: 'prompt_id', promptId: 'p-big' });
        capturedCallbacks?.onEvent({ type: 'error', message: 'went quiet' });

        // Advance well past the base 9-min deadline (135 polls of 4s): each poll
        // delivers a fresh card that extends the window, so the answer on poll 151
        // is still reached.
        for (let i = 0; i < 160; i++) {
          await vi.advanceTimersByTimeAsync(4000);
        }
        const message = useAiChatStore.getState().messages[1];
        expect(message.content).toBe('All imported.');
        expect(message.pendingActions!.length).toBeGreaterThan(100);
        expect(message.error).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps an already-confirmed card confirmed when a later batch arrives', async () => {
      // The user approved a card; then the agent delivered a further batch. The
      // new batch must not reset the approved card back to pending (re-approving
      // an already-applied card errors). The closure only marks cards pending, so
      // the store status must win on every re-render.
      vi.useFakeTimers();
      try {
        const cardA = {
          actionId: 'A',
          type: 'create_transaction' as const,
          preview: {},
          descriptor: { type: 'create_transaction' as const },
          signature: 's',
          expiresAt: Date.now() + 600000,
        };
        const cardB = { ...cardA, actionId: 'B' };
        mockGetRelayResponse
          .mockResolvedValueOnce({ text: null, pendingActions: [cardA] })
          .mockResolvedValueOnce({ text: null, pendingActions: [cardB] })
          .mockResolvedValueOnce({ text: 'Imported.', pendingActions: [] });
        useAiChatStore.getState().submit('Import', undefined, { relay: true });
        capturedCallbacks?.onEvent({ type: 'prompt_id', promptId: 'p-batch' });
        capturedCallbacks?.onEvent({ type: 'error', message: 'went quiet' });

        // Poll 1: card A appears.
        await vi.advanceTimersByTimeAsync(0);
        let msg = useAiChatStore.getState().messages[1];
        expect(msg.pendingActions).toHaveLength(1);

        // The user approves card A (store-side status flip, as confirmAction does).
        useAiChatStore.setState((s) => ({
          messages: s.messages.map((m) =>
            m.id === msg.id
              ? {
                  ...m,
                  pendingActions: m.pendingActions!.map((p) =>
                    p.actionId === 'A' ? { ...p, status: 'confirmed' as const } : p,
                  ),
                }
              : m,
          ),
        }));

        // Poll 2: card B arrives -- card A must stay confirmed.
        await vi.advanceTimersByTimeAsync(4000);
        msg = useAiChatStore.getState().messages[1];
        expect(msg.pendingActions).toHaveLength(2);
        expect(msg.pendingActions!.find((p) => p.actionId === 'A')!.status).toBe('confirmed');
        expect(msg.pendingActions!.find((p) => p.actionId === 'B')!.status).toBe('pending');

        // Poll 3: the answer lands -- card A is still confirmed.
        await vi.advanceTimersByTimeAsync(4000);
        msg = useAiChatStore.getState().messages[1];
        expect(msg.content).toBe('Imported.');
        expect(msg.pendingActions!.find((p) => p.actionId === 'A')!.status).toBe('confirmed');
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops polling for a late answer once a new prompt is submitted', async () => {
      vi.useFakeTimers();
      try {
        mockGetRelayResponse.mockResolvedValue({ text: null });
        useAiChatStore.getState().submit('Q', undefined, { relay: true });
        capturedCallbacks?.onEvent({ type: 'prompt_id', promptId: 'p-cancel' });
        capturedCallbacks?.onEvent({ type: 'error', message: 'went quiet' });
        await vi.advanceTimersByTimeAsync(0);
        const callsAfterFirst = mockGetRelayResponse.mock.calls.length;

        // A new prompt supersedes the poll.
        useAiChatStore.getState().submit('Another question', undefined, { relay: true });
        await vi.advanceTimersByTimeAsync(8000);

        // The superseded poll made no further pickup calls.
        expect(mockGetRelayResponse.mock.calls.length).toBe(callsAfterFirst);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not attempt pickup once content has streamed', async () => {
      useAiChatStore.getState().submit('Q', undefined, { relay: true });

      capturedCallbacks?.onEvent({ type: 'prompt_id', promptId: 'p-4' });
      capturedCallbacks?.onEvent({ type: 'content', text: 'Live answer.' });
      capturedCallbacks?.onEvent({ type: 'error', message: 'late blip' });
      await flush();

      expect(mockGetRelayResponse).not.toHaveBeenCalled();
      const messages = useAiChatStore.getState().messages;
      expect(messages[1]).toMatchObject({
        role: 'assistant',
        content: 'Live answer.',
        error: 'late blip',
      });
    });
  });

  describe('chart events', () => {
    const chart1 = {
      type: 'bar' as const,
      title: 'Spending by Category',
      data: [
        { label: 'Groceries', value: 500 },
        { label: 'Dining', value: 250 },
      ],
    };
    const chart2 = {
      type: 'line' as const,
      title: 'Net Worth',
      data: [
        { label: 'Jan', value: 10000 },
        { label: 'Feb', value: 10500 },
      ],
    };

    it('attaches a chart emitted before content to the assistant message', () => {
      useAiChatStore.getState().submit('Chart my spending');

      capturedCallbacks?.onEvent({ type: 'chart', chart: chart1 });
      capturedCallbacks?.onEvent({ type: 'content', text: 'Here it is.' });
      capturedCallbacks?.onEvent({
        type: 'done',
        usage: { inputTokens: 1, outputTokens: 1, toolCalls: 1 },
      });

      const messages = useAiChatStore.getState().messages;
      expect(messages).toHaveLength(2);
      expect(messages[1].charts).toEqual([chart1]);
      expect(messages[1].isStreaming).toBe(false);
    });

    it('attaches a chart emitted after content mid-stream', () => {
      useAiChatStore.getState().submit('Chart my spending');

      capturedCallbacks?.onEvent({ type: 'content', text: 'Streaming...' });
      capturedCallbacks?.onEvent({ type: 'chart', chart: chart1 });
      capturedCallbacks?.onEvent({
        type: 'done',
        usage: { inputTokens: 1, outputTokens: 1, toolCalls: 1 },
      });

      const messages = useAiChatStore.getState().messages;
      expect(messages[1].charts).toEqual([chart1]);
    });

    it('preserves multiple charts in emission order', () => {
      useAiChatStore.getState().submit('Two charts');

      capturedCallbacks?.onEvent({ type: 'chart', chart: chart1 });
      capturedCallbacks?.onEvent({ type: 'chart', chart: chart2 });
      capturedCallbacks?.onEvent({ type: 'content', text: 'Two.' });
      capturedCallbacks?.onEvent({
        type: 'done',
        usage: { inputTokens: 1, outputTokens: 1, toolCalls: 2 },
      });

      const messages = useAiChatStore.getState().messages;
      expect(messages[1].charts).toEqual([chart1, chart2]);
    });

    it('leaves charts undefined when no chart events arrive', () => {
      useAiChatStore.getState().submit('No chart');

      capturedCallbacks?.onEvent({ type: 'content', text: 'Plain answer.' });
      capturedCallbacks?.onEvent({
        type: 'done',
        usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
      });

      const messages = useAiChatStore.getState().messages;
      expect(messages[1].charts).toBeUndefined();
    });

    it('persists charts across localStorage rehydration', () => {
      useAiChatStore.getState().submit('Chart my spending');

      capturedCallbacks?.onEvent({ type: 'chart', chart: chart1 });
      capturedCallbacks?.onEvent({ type: 'content', text: 'Here.' });
      capturedCallbacks?.onEvent({
        type: 'done',
        usage: { inputTokens: 1, outputTokens: 1, toolCalls: 1 },
      });

      const raw = window.localStorage.getItem(AI_CHAT_STORAGE_KEY);
      expect(raw).not.toBeNull();
      const persisted = JSON.parse(raw as string);
      const assistant = persisted.state.messages.find(
        (m: { role: string }) => m.role === 'assistant',
      );
      expect(assistant.charts).toEqual([chart1]);
    });
  });

  describe('cancel', () => {
    it('aborts the in-flight controller and resets loading state', () => {
      useAiChatStore.getState().submit('Q');
      useAiChatStore.getState().cancel();

      expect(mockAbortController.abort).toHaveBeenCalled();
      expect(useAiChatStore.getState().isLoading).toBe(false);
      expect(useAiChatStore.getState().thinking.active).toBe(false);
    });

    it('marks a partial assistant message as no-longer-streaming', () => {
      useAiChatStore.getState().submit('Q');
      capturedCallbacks?.onEvent({ type: 'content', text: 'Half-' });
      useAiChatStore.getState().cancel();

      const messages = useAiChatStore.getState().messages;
      expect(messages[1]).toMatchObject({
        role: 'assistant',
        content: 'Half-',
        isStreaming: false,
      });
    });
  });

  describe('clear', () => {
    it('aborts in-flight stream and empties messages', () => {
      useAiChatStore.getState().submit('Q');
      useAiChatStore.getState().clear();

      expect(mockAbortController.abort).toHaveBeenCalled();
      expect(useAiChatStore.getState().messages).toEqual([]);
      expect(useAiChatStore.getState().isLoading).toBe(false);
    });
  });

  describe('persistence', () => {
    it('writes only messages to localStorage (not transient state)', () => {
      useAiChatStore.getState().submit('Q');

      const raw = window.localStorage.getItem(AI_CHAT_STORAGE_KEY);
      expect(raw).not.toBeNull();
      const persisted = JSON.parse(raw as string);
      expect(persisted.state).toEqual({
        messages: [
          expect.objectContaining({ role: 'user', content: 'Q' }),
        ],
      });
    });
  });

  describe('_heal', () => {
    it('clears stuck isStreaming flags from a previous session', () => {
      useAiChatStore.setState({
        messages: [
          { id: 'u', role: 'user', content: 'Q' },
          {
            id: 'a',
            role: 'assistant',
            content: 'partial',
            isStreaming: true,
          },
        ],
      });

      useAiChatStore.getState()._heal();

      const messages = useAiChatStore.getState().messages;
      expect(messages[1].isStreaming).toBe(false);
    });

    it('is a no-op when no messages are streaming', () => {
      useAiChatStore.setState({
        messages: [{ id: 'u', role: 'user', content: 'Q' }],
      });
      const before = useAiChatStore.getState().messages;
      useAiChatStore.getState()._heal();
      // Reference equality preserved when no change is needed
      expect(useAiChatStore.getState().messages).toBe(before);
    });
  });

  describe('thinking & tool events', () => {
    it('updates the thinking message on a thinking event', () => {
      useAiChatStore.getState().submit('Q');
      capturedCallbacks?.onEvent({ type: 'thinking', message: 'Working on it' });
      expect(useAiChatStore.getState().thinking.message).toBe('Working on it');
    });

    it('falls back to "Thinking..." when no message is supplied', () => {
      useAiChatStore.getState().submit('Q');
      capturedCallbacks?.onEvent({ type: 'thinking' } as any);
      expect(useAiChatStore.getState().thinking.message).toBe('Thinking...');
    });

    it('accumulates assistant_text into thinking.liveText', () => {
      useAiChatStore.getState().submit('Q');
      capturedCallbacks?.onEvent({ type: 'assistant_text', text: 'Hello, ' });
      capturedCallbacks?.onEvent({ type: 'assistant_text', text: 'world.' });
      expect(useAiChatStore.getState().thinking.liveText).toBe('Hello, world.');
    });

    it('records tool start and result events', () => {
      useAiChatStore.getState().submit('Q');
      capturedCallbacks?.onEvent({ type: 'tool_start', name: 'get_balances' });
      let tools = useAiChatStore.getState().thinking.tools;
      expect(tools[0]).toMatchObject({ name: 'get_balances', status: 'running' });

      capturedCallbacks?.onEvent({
        type: 'tool_result',
        name: 'get_balances',
        summary: '5 accounts',
      });
      tools = useAiChatStore.getState().thinking.tools;
      expect(tools[0]).toMatchObject({
        name: 'get_balances',
        status: 'done',
        summary: '5 accounts',
      });

      capturedCallbacks?.onEvent({ type: 'content', text: 'Done' });
      capturedCallbacks?.onEvent({
        type: 'done',
        usage: { inputTokens: 1, outputTokens: 1, toolCalls: 1 },
      });

      const messages = useAiChatStore.getState().messages;
      expect(messages[1].toolsUsed).toHaveLength(1);
      expect(messages[1].toolsUsed?.[0].summary).toBe('5 accounts');
    });

    it('records tool errors via isError flag', () => {
      useAiChatStore.getState().submit('Q');
      capturedCallbacks?.onEvent({ type: 'tool_start', name: 'broken_tool' });
      capturedCallbacks?.onEvent({
        type: 'tool_result',
        name: 'broken_tool',
        summary: 'failed',
        isError: true,
      });
      const tools = useAiChatStore.getState().thinking.tools;
      expect(tools[0].isError).toBe(true);
    });

    it('forwards sources event into the assistant message on done', () => {
      useAiChatStore.getState().submit('Q');
      capturedCallbacks?.onEvent({ type: 'content', text: 'Answer' });
      capturedCallbacks?.onEvent({
        type: 'sources',
        sources: [{ type: 'transactions', description: '5 rows' }],
      });
      capturedCallbacks?.onEvent({
        type: 'done',
        usage: { inputTokens: 1, outputTokens: 1, toolCalls: 0 },
      });
      const messages = useAiChatStore.getState().messages;
      expect(messages[1].sources).toHaveLength(1);
      expect(messages[1].sources?.[0].description).toBe('5 rows');
    });

    it('marks assistant message with error when error follows content', async () => {
      useAiChatStore.getState().submit('Q');
      capturedCallbacks?.onEvent({ type: 'content', text: 'Partial...' });
      capturedCallbacks?.onEvent({ type: 'error', message: 'Stream broke' });
      await flush();
      const messages = useAiChatStore.getState().messages;
      expect(messages[1].isStreaming).toBe(false);
      expect(messages[1].error).toBe('Stream broke');
      expect(useAiChatStore.getState().isLoading).toBe(false);
    });
  });

  describe('onDone backstop', () => {
    it('clears loading state when stream closes without a done event', async () => {
      useAiChatStore.getState().submit('Q');
      capturedCallbacks?.onDone?.();
      await flush();
      expect(useAiChatStore.getState().isLoading).toBe(false);
      expect(useAiChatStore.getState().thinking.active).toBe(false);
    });
  });

  describe('onError handling', () => {
    it('preserves partial assistant message and resets loading on error after content', async () => {
      useAiChatStore.getState().submit('Q');
      capturedCallbacks?.onEvent({ type: 'content', text: 'Half-' });
      capturedCallbacks?.onError?.(new Error('boom'));
      await flush();

      const state = useAiChatStore.getState();
      expect(state.isLoading).toBe(false);
      // Partial content remains; no extra error message appended
      const assistant = state.messages.find((m) => m.role === 'assistant');
      expect(assistant?.content).toBe('Half-');
    });
  });

  describe('cancel edge cases', () => {
    it('is a no-op when there is no active stream', () => {
      // No prior submit
      useAiChatStore.getState().cancel();
      expect(useAiChatStore.getState().isLoading).toBe(false);
    });
  });

  describe('clear edge cases', () => {
    it('does not throw when there is no active controller', () => {
      expect(() => useAiChatStore.getState().clear()).not.toThrow();
      expect(useAiChatStore.getState().messages).toEqual([]);
    });
  });

  describe('streaming edge cases – fallback values', () => {
    it('handles assistant_text with no text (empty fallback)', () => {
      useAiChatStore.getState().submit('Q');
      capturedCallbacks?.onEvent({ type: 'assistant_text' } as any);
      expect(useAiChatStore.getState().thinking.liveText).toBe('');
    });

    it('handles tool_start with no name (empty fallback)', () => {
      useAiChatStore.getState().submit('Q');
      capturedCallbacks?.onEvent({ type: 'tool_start' } as any);
      const tools = useAiChatStore.getState().thinking.tools;
      expect(tools[0]).toMatchObject({ name: '', status: 'running' });
    });

    it('handles tool_result when no matching tool exists', () => {
      useAiChatStore.getState().submit('Q');
      capturedCallbacks?.onEvent({ type: 'tool_start', name: 'tool_a' });
      capturedCallbacks?.onEvent({ type: 'tool_result', name: 'nonexistent' });
      const tools = useAiChatStore.getState().thinking.tools;
      // tool_a still running since result was for a different name
      expect(tools[0]).toMatchObject({ name: 'tool_a', status: 'running' });
    });

    it('handles tool_result with no summary (empty fallback)', () => {
      useAiChatStore.getState().submit('Q');
      capturedCallbacks?.onEvent({ type: 'tool_start', name: 'tool_a' });
      capturedCallbacks?.onEvent({ type: 'tool_result', name: 'tool_a' } as any);
      const tools = useAiChatStore.getState().thinking.tools;
      expect(tools[0].summary).toBeUndefined();
    });

    it('handles chart event with no chart data (no-op)', () => {
      useAiChatStore.getState().submit('Q');
      capturedCallbacks?.onEvent({ type: 'chart' } as any);
      capturedCallbacks?.onEvent({ type: 'content', text: 'Answer' });
      const messages = useAiChatStore.getState().messages;
      expect(messages[1].charts).toBeUndefined();
    });

    it('handles multiple content events (second updates without re-creating message)', () => {
      useAiChatStore.getState().submit('Q');
      capturedCallbacks?.onEvent({ type: 'content', text: 'Part 1 ' });
      capturedCallbacks?.onEvent({ type: 'content', text: 'Part 1 Part 2' });
      const messages = useAiChatStore.getState().messages;
      expect(messages[1].content).toBe('Part 1 Part 2');
    });

    it('handles content event with no text (empty fallback)', () => {
      useAiChatStore.getState().submit('Q');
      capturedCallbacks?.onEvent({ type: 'content' } as any);
      const messages = useAiChatStore.getState().messages;
      expect(messages[1].content).toBe('');
    });

    it('handles error event with no message (default message used)', async () => {
      useAiChatStore.getState().submit('Q');
      capturedCallbacks?.onEvent({ type: 'error' } as any);
      await flush();
      const messages = useAiChatStore.getState().messages;
      expect(messages[1].error).toBe('An error occurred');
    });

    it('onDone is a no-op when already not loading', async () => {
      useAiChatStore.getState().submit('Q');
      // First onDone clears loading state
      capturedCallbacks?.onDone?.();
      await flush();
      expect(useAiChatStore.getState().isLoading).toBe(false);
      // Second call should not throw and stays not loading
      capturedCallbacks?.onDone?.();
      await flush();
      expect(useAiChatStore.getState().isLoading).toBe(false);
    });

    it('onError before any content creates an error assistant message', async () => {
      useAiChatStore.getState().submit('Q');
      capturedCallbacks?.onError?.(new Error('connect failed'));
      await flush();
      const state = useAiChatStore.getState();
      expect(state.isLoading).toBe(false);
      const assistant = state.messages.find((m) => m.role === 'assistant');
      expect(assistant?.error).toBe('connect failed');
    });

    it('onError with no message uses fallback message', async () => {
      useAiChatStore.getState().submit('Q');
      capturedCallbacks?.onError?.({ message: '' } as Error);
      await flush();
      const state = useAiChatStore.getState();
      const assistant = state.messages.find((m) => m.role === 'assistant');
      expect(assistant?.error).toBe('Failed to connect to the AI service.');
    });
  });

  describe('pending actions', () => {
    const action = {
      actionId: 'a1',
      type: 'create_transaction' as const,
      expiresAt: Date.now() + 60_000,
      signature: 'sig',
      descriptor: { type: 'create_transaction' },
      preview: { accountName: 'Checking', amount: -12.5 },
    };

    function streamWithPendingAction() {
      useAiChatStore.getState().submit('add a transaction');
      capturedCallbacks?.onEvent({ type: 'pending_action', action });
      capturedCallbacks?.onEvent({ type: 'content', text: 'Review the card.' });
      capturedCallbacks?.onEvent({
        type: 'done',
        usage: { inputTokens: 1, outputTokens: 1, toolCalls: 1 },
      });
      const assistant = useAiChatStore
        .getState()
        .messages.find((m) => m.role === 'assistant')!;
      return assistant;
    }

    it('attaches a pending action card to the assistant message', () => {
      const assistant = streamWithPendingAction();
      expect(assistant.pendingActions).toHaveLength(1);
      expect(assistant.pendingActions![0]).toMatchObject({
        actionId: 'a1',
        status: 'pending',
      });
    });

    it('accumulates multiple pending_action events into separate cards (individual approval)', () => {
      useAiChatStore.getState().submit('add several transactions');
      capturedCallbacks?.onEvent({ type: 'pending_action', action });
      capturedCallbacks?.onEvent({
        type: 'pending_action',
        action: { ...action, actionId: 'a2' },
      });
      capturedCallbacks?.onEvent({
        type: 'content',
        text: 'Review the cards.',
      });
      capturedCallbacks?.onEvent({
        type: 'done',
        usage: { inputTokens: 1, outputTokens: 1, toolCalls: 1 },
      });
      const assistant = useAiChatStore
        .getState()
        .messages.find((m) => m.role === 'assistant')!;
      expect(assistant.pendingActions).toHaveLength(2);
      expect(assistant.pendingActions!.map((a) => a.actionId)).toEqual([
        'a1',
        'a2',
      ]);
      expect(
        assistant.pendingActions!.every((a) => a.status === 'pending'),
      ).toBe(true);
    });

    it('confirmAction posts the descriptor and marks the card confirmed', async () => {
      mockConfirmAction.mockResolvedValueOnce({
        type: 'create_transaction',
        id: 'tx-1',
      });
      const assistant = streamWithPendingAction();
      await useAiChatStore.getState().confirmAction(assistant.id, 'a1');

      expect(mockConfirmAction).toHaveBeenCalledWith({
        actionId: 'a1',
        signature: 'sig',
        descriptor: { type: 'create_transaction' },
      });
      const updated = useAiChatStore
        .getState()
        .messages.find((m) => m.id === assistant.id)!;
      expect(updated.pendingActions![0]).toMatchObject({
        status: 'confirmed',
        resultId: 'tx-1',
      });
    });

    it('confirmAction notifies list pages to refresh after a successful write', async () => {
      mockConfirmAction.mockResolvedValueOnce({
        type: 'create_transaction',
        id: 'tx-1',
      });
      const assistant = streamWithPendingAction();
      await useAiChatStore.getState().confirmAction(assistant.id, 'a1');
      expect(mockNotifyAiAction).toHaveBeenCalledTimes(1);
    });

    it('confirmAction does not notify list pages when the write fails', async () => {
      mockConfirmAction.mockRejectedValueOnce({
        response: { data: { message: 'Nope' } },
      });
      const assistant = streamWithPendingAction();
      await useAiChatStore.getState().confirmAction(assistant.id, 'a1');
      expect(mockNotifyAiAction).not.toHaveBeenCalled();
    });

    it('confirmAction carries bulk count and skipped onto the confirmed card', async () => {
      const bulkAction = {
        actionId: 'b1',
        type: 'create_transactions' as const,
        expiresAt: Date.now() + 60_000,
        signature: 'sig',
        descriptor: { type: 'create_transactions' },
        preview: { rows: [{ status: 'ok' as const, amount: -10 }] },
      };
      mockConfirmAction.mockResolvedValueOnce({
        type: 'create_transactions',
        id: 'tx-1',
        ids: ['tx-1'],
        count: 1,
        skipped: [{ index: 1, reason: 'Unknown account' }],
      });
      useAiChatStore.getState().submit('add transactions');
      capturedCallbacks?.onEvent({ type: 'pending_action', action: bulkAction });
      capturedCallbacks?.onEvent({ type: 'content', text: 'Review.' });
      capturedCallbacks?.onEvent({
        type: 'done',
        usage: { inputTokens: 1, outputTokens: 1, toolCalls: 1 },
      });
      const assistant = useAiChatStore
        .getState()
        .messages.find((m) => m.role === 'assistant')!;

      await useAiChatStore.getState().confirmAction(assistant.id, 'b1');

      const updated = useAiChatStore
        .getState()
        .messages.find((m) => m.id === assistant.id)!;
      expect(updated.pendingActions![0]).toMatchObject({
        status: 'confirmed',
        resultId: 'tx-1',
        resultCount: 1,
        resultSkipped: [{ index: 1, reason: 'Unknown account' }],
      });
    });

    it('confirmAction records an error when the request fails', async () => {
      mockConfirmAction.mockRejectedValueOnce({
        response: { data: { message: 'Nope' } },
      });
      const assistant = streamWithPendingAction();
      await useAiChatStore.getState().confirmAction(assistant.id, 'a1');

      const updated = useAiChatStore
        .getState()
        .messages.find((m) => m.id === assistant.id)!;
      expect(updated.pendingActions![0]).toMatchObject({
        status: 'error',
        errorMessage: 'Nope',
      });
    });

    it('does not re-submit a non-pending action (double-submit guard)', async () => {
      mockConfirmAction.mockResolvedValue({
        type: 'create_transaction',
        id: 'tx-1',
      });
      const assistant = streamWithPendingAction();
      await useAiChatStore.getState().confirmAction(assistant.id, 'a1');
      await useAiChatStore.getState().confirmAction(assistant.id, 'a1');
      expect(mockConfirmAction).toHaveBeenCalledTimes(1);
    });

    it('cancelAction marks the card cancelled without a request', () => {
      const assistant = streamWithPendingAction();
      useAiChatStore.getState().cancelAction(assistant.id, 'a1');
      const updated = useAiChatStore
        .getState()
        .messages.find((m) => m.id === assistant.id)!;
      expect(updated.pendingActions![0].status).toBe('cancelled');
      expect(mockConfirmAction).not.toHaveBeenCalled();
    });

    it('_heal expires pending actions restored from storage', () => {
      useAiChatStore.setState({
        messages: [
          {
            id: 'm1',
            role: 'assistant',
            content: 'x',
            pendingActions: [{ ...action, status: 'pending' }],
          },
        ],
      });
      useAiChatStore.getState()._heal();
      const updated = useAiChatStore.getState().messages[0];
      expect(updated.pendingActions![0].status).toBe('expired');
    });
  });
});
