import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { aiApi } from '@/lib/ai';
import type { ChartPayload, StreamEvent } from '@/types/ai';

// Key for persisting the AI conversation in the browser's localStorage.
// Cleared on logout via authStore so conversations don't leak between accounts.
export const AI_CHAT_STORAGE_KEY = 'monize:ai-chat-messages';

export interface ToolCallRecord {
  name: string;
  summary: string;
  input?: Record<string, unknown>;
  isError?: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolsUsed?: ToolCallRecord[];
  sources?: Array<{ type: string; description: string; dateRange?: string }>;
  // Charts the assistant rendered via the render_chart tool. Populated as
  // `chart` SSE events arrive during streaming; rendered inline in
  // <ChatMessage> below the text content.
  charts?: ChartPayload[];
  isStreaming?: boolean;
  error?: string;
}

export interface ThinkingState {
  active: boolean;
  message: string;
  // Live streamed text from the model — accumulates per iteration as the
  // backend emits assistant_text deltas. Reset on each new tool_start so the
  // user sees the next "thinking" pass cleanly.
  liveText: string;
  tools: Array<{
    name: string;
    status: 'running' | 'done';
    summary?: string;
    isError?: boolean;
  }>;
}

const IDLE_THINKING: ThinkingState = {
  active: false,
  message: '',
  liveText: '',
  tools: [],
};

interface AiChatState {
  messages: ChatMessage[];
  isLoading: boolean;
  thinking: ThinkingState;
  // Transient (not persisted): tracks the in-flight stream so we can cancel
  // even after the user navigates away and comes back.
  _abortController: AbortController | null;
  // Transient (not persisted): the assistant message id being written by the
  // current stream. Lets us reattach if the user returns mid-stream.
  _activeAssistantId: string | null;

  submit: (query: string) => void;
  cancel: () => void;
  clear: () => void;
  // Heal stuck flags from a previous session that was killed mid-stream
  // (e.g. tab closed). Called once on rehydration.
  _heal: () => void;
}

export const useAiChatStore = create<AiChatState>()(
  persist(
    (set, get) => ({
      messages: [],
      isLoading: false,
      thinking: IDLE_THINKING,
      _abortController: null,
      _activeAssistantId: null,

      submit: (query: string) => {
        const trimmed = query.trim();
        if (!trimmed || get().isLoading) return;

        const userMsgId = `user-${Date.now()}`;
        const assistantMsgId = `assistant-${Date.now()}`;

        set((state) => ({
          messages: [
            ...state.messages,
            { id: userMsgId, role: 'user', content: trimmed },
          ],
          isLoading: true,
          thinking: {
            active: true,
            message: 'Analyzing your question...',
            liveText: '',
            tools: [],
          },
          _activeAssistantId: assistantMsgId,
        }));

        // Per-request mutable state. Lives in this closure for the lifetime
        // of the stream, independent of any React component.
        const toolsUsed: ToolCallRecord[] = [];
        const charts: ChartPayload[] = [];
        let sources: ChatMessage['sources'] = [];
        let contentBuffer = '';
        let hasStartedContent = false;

        // Build conversation history from existing messages for context.
        // Only include completed (non-streaming, non-error) messages with
        // actual content so the AI can reference prior turns.
        const history = get()
          .messages.filter(
            (m) =>
              !m.isStreaming &&
              !m.error &&
              m.content.length > 0,
          )
          .map((m) => ({ role: m.role, content: m.content }));

        const controller = aiApi.queryStream(trimmed, {
          onEvent: (event: StreamEvent) => {
            switch (event.type) {
              case 'thinking':
                set((state) => ({
                  thinking: {
                    ...state.thinking,
                    message: event.message || 'Thinking...',
                  },
                }));
                break;

              case 'assistant_text':
                set((state) => ({
                  thinking: {
                    ...state.thinking,
                    liveText: state.thinking.liveText + (event.text || ''),
                  },
                }));
                break;

              case 'tool_start':
                toolsUsed.push({
                  name: event.name || '',
                  summary: '',
                  input: event.input,
                });
                set((state) => ({
                  thinking: {
                    ...state.thinking,
                    message: `Looking up ${event.name?.replace(/_/g, ' ')}...`,
                    liveText: '',
                    tools: [
                      ...state.thinking.tools,
                      { name: event.name || '', status: 'running' },
                    ],
                  },
                }));
                break;

              case 'tool_result': {
                for (let i = 0; i < toolsUsed.length; i++) {
                  if (
                    toolsUsed[i].name === event.name &&
                    !toolsUsed[i].summary &&
                    toolsUsed[i].isError === undefined
                  ) {
                    toolsUsed[i] = {
                      ...toolsUsed[i],
                      summary: event.summary || '',
                      isError: event.isError === true,
                    };
                    break;
                  }
                }
                set((state) => {
                  let updated = false;
                  return {
                    thinking: {
                      ...state.thinking,
                      tools: state.thinking.tools.map((t) => {
                        if (
                          !updated &&
                          t.name === event.name &&
                          t.status === 'running'
                        ) {
                          updated = true;
                          return {
                            ...t,
                            status: 'done',
                            summary: event.summary,
                            isError: event.isError === true,
                          };
                        }
                        return t;
                      }),
                    },
                  };
                });
                break;
              }

              case 'chart':
                if (event.chart) {
                  charts.push(event.chart);
                  // If the assistant message already exists (chart event
                  // arriving after content started), attach immediately so
                  // the chart shows up mid-stream. Otherwise we'll pick it
                  // up when 'content' creates the message.
                  if (hasStartedContent) {
                    set((state) => ({
                      messages: state.messages.map((m) =>
                        m.id === assistantMsgId
                          ? { ...m, charts: [...charts] }
                          : m,
                      ),
                    }));
                  }
                }
                break;

              case 'content':
                if (!hasStartedContent) {
                  hasStartedContent = true;
                  set((state) => ({
                    thinking: IDLE_THINKING,
                    messages: [
                      ...state.messages,
                      {
                        id: assistantMsgId,
                        role: 'assistant',
                        content: event.text || '',
                        toolsUsed: [...toolsUsed],
                        charts: charts.length > 0 ? [...charts] : undefined,
                        isStreaming: true,
                      },
                    ],
                  }));
                }
                contentBuffer = event.text || '';
                set((state) => ({
                  messages: state.messages.map((m) =>
                    m.id === assistantMsgId
                      ? {
                          ...m,
                          content: contentBuffer,
                          toolsUsed: [...toolsUsed],
                          charts: charts.length > 0 ? [...charts] : m.charts,
                        }
                      : m,
                  ),
                }));
                break;

              case 'sources':
                sources =
                  (event.sources as ChatMessage['sources']) || [];
                break;

              case 'done':
                set((state) => ({
                  messages: state.messages.map((m) =>
                    m.id === assistantMsgId
                      ? {
                          ...m,
                          isStreaming: false,
                          sources,
                          charts: charts.length > 0 ? [...charts] : m.charts,
                        }
                      : m,
                  ),
                  isLoading: false,
                  thinking: IDLE_THINKING,
                  _abortController: null,
                  _activeAssistantId: null,
                }));
                break;

              case 'error':
                set((state) => {
                  const errorMsg = (event.message as string) || 'An error occurred';
                  if (hasStartedContent) {
                    return {
                      messages: state.messages.map((m) =>
                        m.id === assistantMsgId
                          ? { ...m, isStreaming: false, error: errorMsg }
                          : m,
                      ),
                      isLoading: false,
                      thinking: IDLE_THINKING,
                      _abortController: null,
                      _activeAssistantId: null,
                    };
                  }
                  return {
                    messages: [
                      ...state.messages,
                      {
                        id: assistantMsgId,
                        role: 'assistant',
                        content: '',
                        error: errorMsg,
                      },
                    ],
                    isLoading: false,
                    thinking: IDLE_THINKING,
                    _abortController: null,
                    _activeAssistantId: null,
                  };
                });
                break;
            }
          },
          onDone: () => {
            // Backstop in case the server closes without a 'done' event.
            if (get().isLoading) {
              set({
                isLoading: false,
                thinking: IDLE_THINKING,
                _abortController: null,
                _activeAssistantId: null,
              });
            }
          },
          onError: (error) => {
            set((state) => {
              const errorMsg = error.message || 'Failed to connect to the AI service.';
              if (!hasStartedContent) {
                return {
                  messages: [
                    ...state.messages,
                    {
                      id: assistantMsgId,
                      role: 'assistant',
                      content: '',
                      error: errorMsg,
                    },
                  ],
                  isLoading: false,
                  thinking: IDLE_THINKING,
                  _abortController: null,
                  _activeAssistantId: null,
                };
              }
              return {
                isLoading: false,
                thinking: IDLE_THINKING,
                _abortController: null,
                _activeAssistantId: null,
              };
            });
          },
        }, history);

        set({ _abortController: controller });
      },

      cancel: () => {
        const { _abortController, _activeAssistantId } = get();
        _abortController?.abort();
        set((state) => ({
          isLoading: false,
          thinking: IDLE_THINKING,
          _abortController: null,
          _activeAssistantId: null,
          // If we already started writing the assistant message, mark it as
          // no-longer-streaming so it doesn't render as in-flight on return.
          messages: _activeAssistantId
            ? state.messages.map((m) =>
                m.id === _activeAssistantId
                  ? { ...m, isStreaming: false }
                  : m,
              )
            : state.messages,
        }));
      },

      clear: () => {
        get()._abortController?.abort();
        set({
          messages: [],
          isLoading: false,
          thinking: IDLE_THINKING,
          _abortController: null,
          _activeAssistantId: null,
        });
      },

      _heal: () => {
        set((state) => {
          // After rehydration, no stream is actually running — the abort
          // controller from the previous tab/page is gone. Any persisted
          // isStreaming flag is stale.
          if (!state.messages.some((m) => m.isStreaming)) return {};
          return {
            messages: state.messages.map((m) =>
              m.isStreaming ? { ...m, isStreaming: false } : m,
            ),
          };
        });
      },
    }),
    {
      name: AI_CHAT_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      // Only persist the messages — transient UI state (loading, thinking,
      // abort controller) belongs to the live in-memory session.
      partialize: (state) => ({ messages: state.messages }),
      onRehydrateStorage: () => (state) => {
        state?._heal();
      },
    },
  ),
);
