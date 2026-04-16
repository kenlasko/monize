import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  useAiChatStore,
  AI_CHAT_STORAGE_KEY,
} from './aiChatStore';
import type { StreamCallbacks } from '@/types/ai';

let capturedCallbacks: StreamCallbacks | null = null;
const mockAbortController = { abort: vi.fn() };

vi.mock('@/lib/ai', () => ({
  aiApi: {
    queryStream: vi.fn((_query: string, callbacks: StreamCallbacks) => {
      capturedCallbacks = callbacks;
      return mockAbortController;
    }),
  },
}));

describe('aiChatStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedCallbacks = null;
    window.localStorage.removeItem(AI_CHAT_STORAGE_KEY);
    useAiChatStore.setState({
      messages: [],
      isLoading: false,
      thinking: { active: false, message: '', liveText: '', tools: [] },
      _abortController: null,
      _activeAssistantId: null,
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

    it('records errors against the assistant message', () => {
      useAiChatStore.getState().submit('Q');

      capturedCallbacks?.onEvent({
        type: 'error',
        message: 'Provider unavailable',
      });

      const messages = useAiChatStore.getState().messages;
      expect(messages).toHaveLength(2);
      expect(messages[1]).toMatchObject({
        role: 'assistant',
        error: 'Provider unavailable',
      });
      expect(useAiChatStore.getState().isLoading).toBe(false);
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
  });
});
