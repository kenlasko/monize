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
