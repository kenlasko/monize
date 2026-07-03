import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { aiApi } from '@/lib/ai';
import { notifyAiAction } from '@/lib/aiActionSignal';
import type {
  ChartPayload,
  PendingAction,
  StreamEvent,
  AttachmentPayload,
  ChatAttachmentMeta,
} from '@/types/ai';

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
  // Attachments the user sent with this message. Metadata only (no base64) so
  // the persisted conversation stays small; rendered as chips on the bubble.
  attachments?: ChatAttachmentMeta[];
  toolsUsed?: ToolCallRecord[];
  sources?: Array<{ type: string; description: string; dateRange?: string }>;
  // Charts the assistant rendered via the render_chart tool. Populated as
  // `chart` SSE events arrive during streaming; rendered inline in
  // <ChatMessage> below the text content.
  charts?: ChartPayload[];
  // Write actions the assistant proposed via `pending_action` events. Each is
  // rendered as a confirmation card the user can approve or cancel.
  pendingActions?: PendingAction[];
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

// After a relay disconnect, poll the pickup endpoint this often for the late
// answer the agent may still buffer, giving up after the deadline. The deadline
// stays just under the server-side buffer TTL (10 min) so we keep polling for
// as long as the answer could still be retained -- a large tool-call payload or
// a long final summary can take several minutes of quiet composition before the
// agent posts, well past the server's idle timeout.
const RELAY_PICKUP_POLL_MS = 4000;
const RELAY_PICKUP_DEADLINE_MS = 9 * 60 * 1000;

// Bound the conversation history sent in relay mode. The agent receives it on
// every prompt via get_next_prompt and runs the loop in one long-lived session,
// so an unbounded history bloats its context until the model degrades. Keep the
// newest turns within a char budget (the backend trims again as the source of
// truth). The native LLM path is unaffected.
const RELAY_MAX_HISTORY_TURNS = 10;
const RELAY_MAX_HISTORY_CHARS = 12000;

function trimRelayHistory(
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const kept: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let budget = RELAY_MAX_HISTORY_CHARS;
  for (
    let i = history.length - 1;
    i >= 0 && kept.length < RELAY_MAX_HISTORY_TURNS && budget > 0;
    i--
  ) {
    const { role, content } = history[i];
    if (content.length <= budget) {
      kept.push({ role, content });
      budget -= content.length;
    } else {
      if (kept.length === 0) {
        kept.push({ role, content: content.slice(0, budget) + ' … [truncated]' });
      }
      break;
    }
  }
  return kept.reverse();
}

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
  // Transient (not persisted): cancels an in-flight relay late-answer poll
  // loop (started after a relay disconnect). Invoked by cancel()/clear() and
  // when a new prompt is submitted.
  _relayPollCancel: (() => void) | null;

  submit: (
    query: string,
    attachments?: AttachmentPayload[],
    opts?: { relay?: boolean },
  ) => void;
  cancel: () => void;
  clear: () => void;
  // Approve a proposed write action: posts it to the confirm endpoint and
  // updates the card's status. No-op unless the action is still 'pending'.
  confirmAction: (messageId: string, actionId: string) => Promise<void>;
  // Dismiss a proposed write action locally (nothing was persisted).
  cancelAction: (messageId: string, actionId: string) => void;
  // Heal stuck flags from a previous session that was killed mid-stream
  // (e.g. tab closed). Called once on rehydration.
  _heal: () => void;
}

/**
 * Immutably patch a single pending action on a single message.
 */
function patchPendingAction(
  messages: ChatMessage[],
  messageId: string,
  actionId: string,
  patch: Partial<PendingAction>,
): ChatMessage[] {
  return messages.map((m) =>
    m.id === messageId
      ? {
          ...m,
          pendingActions: m.pendingActions?.map((a) =>
            a.actionId === actionId ? { ...a, ...patch } : a,
          ),
        }
      : m,
  );
}

export const useAiChatStore = create<AiChatState>()(
  persist(
    (set, get) => ({
      messages: [],
      isLoading: false,
      thinking: IDLE_THINKING,
      _abortController: null,
      _activeAssistantId: null,
      _relayPollCancel: null,

      submit: (
        query: string,
        attachments?: AttachmentPayload[],
        opts?: { relay?: boolean },
      ) => {
        const trimmed = query.trim();
        if (!trimmed || get().isLoading) return;

        // A new prompt supersedes any relay late-answer poll still running from
        // a previous (disconnected) turn.
        get()._relayPollCancel?.();

        // Relay mode (the caller passes relay=true when the user's top provider
        // is the MCP relay) sends the prompt to the user's own agent instead of
        // a server-side provider; the same SSE events flow back.
        const relay = opts?.relay ?? false;

        const userMsgId = `user-${Date.now()}`;
        const assistantMsgId = `assistant-${Date.now()}`;

        // Persist only lightweight attachment metadata on the message (no
        // base64) so localStorage stays small and binaries don't leak across
        // reloads. The base64 payload is sent on this request only.
        const attachmentMeta: ChatAttachmentMeta[] | undefined =
          attachments && attachments.length > 0
            ? attachments.map((a) => ({
                kind: a.kind,
                mediaType: a.mediaType,
                filename: a.filename,
              }))
            : undefined;

        set((state) => ({
          messages: [
            ...state.messages,
            {
              id: userMsgId,
              role: 'user',
              content: trimmed,
              ...(attachmentMeta ? { attachments: attachmentMeta } : {}),
            },
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
        const pendingActions: PendingAction[] = [];
        let sources: ChatMessage['sources'] = [];
        let contentBuffer = '';
        let hasStartedContent = false;
        // Relay only: the promptId the backend assigns this stream. If the SSE
        // stream dies before the agent answers (its API connection blipped),
        // we use this to pick up the buffered late answer instead of showing a
        // hard error.
        let relayPromptId: string | null = null;
        // Guards the one-shot pickup so the error event and the onError/onDone
        // callbacks cannot trigger it twice.
        let pickupAttempted = false;

        // Render a terminal error on the assistant message. If the message
        // already exists (content streamed, or a confirmation card / chart was
        // rendered before any text), the error is attached to it so those parts
        // survive; otherwise a fresh placeholder is appended, still carrying any
        // cards collected so far so a card the agent posted live is not wiped by
        // the disconnect placeholder.
        const renderError = (errorMsg: string): void => {
          set((state) => {
            const exists = state.messages.some((m) => m.id === assistantMsgId);
            if (exists) {
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
                ...state.messages.filter((m) => m.id !== assistantMsgId),
                {
                  id: assistantMsgId,
                  role: 'assistant',
                  content: '',
                  ...(pendingActions.length > 0
                    ? { pendingActions: [...pendingActions] }
                    : {}),
                  error: errorMsg,
                },
              ],
              isLoading: false,
              thinking: IDLE_THINKING,
              _abortController: null,
              _activeAssistantId: null,
            };
          });
        };

        // Project the collected cards onto the message while preserving any
        // status the user has already set in the store. The closure only ever
        // marks a card 'pending', so re-rendering it verbatim (when a later batch
        // or the final answer arrives) would reset a card the user just approved
        // back to pending -- and re-approving an already-applied card errors. The
        // store is the source of truth for status; merge onto it every time.
        const projectPendingActions = (
          current: ChatMessage | undefined,
        ): PendingAction[] => {
          const statusById = new Map(
            (current?.pendingActions ?? []).map((a) => [a.actionId, a.status]),
          );
          return pendingActions.map((a) => {
            const status = statusById.get(a.actionId);
            return status && status !== a.status ? { ...a, status } : a;
          });
        };

        // Render a late relay answer as a normal assistant message, replacing
        // any disconnect placeholder. Keeps any confirmation cards already
        // picked up so a buffered card is not dropped when the answer arrives.
        const deliverLateAnswer = (text: string): void => {
          set((state) => {
            const merged = projectPendingActions(
              state.messages.find((m) => m.id === assistantMsgId),
            );
            return {
              messages: [
                ...state.messages.filter((m) => m.id !== assistantMsgId),
                {
                  id: assistantMsgId,
                  role: 'assistant',
                  content: text,
                  ...(merged.length > 0 ? { pendingActions: merged } : {}),
                },
              ],
              isLoading: false,
              thinking: IDLE_THINKING,
              _abortController: null,
              _activeAssistantId: null,
              _relayPollCancel: null,
            };
          });
        };

        // Render confirmation cards picked up after the stream gave up (the
        // agent composed them slowly and the turn idle-timed-out, #793). New
        // cards (by actionId) are added to the assistant message, replacing any
        // disconnect placeholder; the pickup loop keeps polling for the answer.
        // Returns true when at least one new card was added, so the poll loop can
        // extend its deadline while the agent is still actively delivering.
        const deliverLateActions = (
          incoming: Omit<PendingAction, 'status'>[],
        ): boolean => {
          let added = false;
          for (const action of incoming) {
            if (!pendingActions.some((p) => p.actionId === action.actionId)) {
              pendingActions.push({ ...action, status: 'pending' });
              added = true;
            }
          }
          if (!added) return false;
          set((state) => {
            const current = state.messages.find((m) => m.id === assistantMsgId);
            return {
              messages: [
                ...state.messages.filter((m) => m.id !== assistantMsgId),
                {
                  id: assistantMsgId,
                  role: 'assistant',
                  content: current?.content ?? '',
                  pendingActions: projectPendingActions(current),
                },
              ],
            };
          });
          return true;
        };

        // Create the assistant message, or merge the latest streamed fields into
        // it. Lets a confirmation card or chart that arrives before any text
        // render immediately (instead of staying invisible until `content`), so
        // the user sees the agent's work as it lands -- and the card lives in
        // state, not just the closure, so a disconnect cannot lose it. Does not
        // touch `hasStartedContent`: a cards-only message still triggers the
        // late-answer pickup, since only real text content suppresses it.
        const upsertAssistantMessage = (): void => {
          set((state) => {
            const existing = state.messages.find((m) => m.id === assistantMsgId);
            const merged = projectPendingActions(existing);
            const fields = {
              content: contentBuffer,
              toolsUsed: [...toolsUsed],
              ...(charts.length > 0 ? { charts: [...charts] } : {}),
              ...(merged.length > 0 ? { pendingActions: merged } : {}),
              isStreaming: true,
            };
            return {
              messages: existing
                ? state.messages.map((m) =>
                    m.id === assistantMsgId ? { ...m, ...fields } : m,
                  )
                : [
                    ...state.messages,
                    { id: assistantMsgId, role: 'assistant', ...fields },
                  ],
            };
          });
        };

        // Recover a late relay answer. The agent's API can blip and it may
        // post its answer only AFTER the stream has disconnected/timed out, so
        // a single pickup at close time usually races ahead of the buffered
        // answer (the bug this fixes). Instead: show the disconnect placeholder
        // immediately, then poll the pickup endpoint until the answer lands or
        // the deadline passes (kept under the server-side buffer TTL). Returns
        // true when it took ownership of finishing the turn (relay + recoverable
        // + not already attempted); false so the caller can fall back to a hard
        // error.
        const pollRelayPickup = (placeholderMsg?: string): boolean => {
          if (
            !relay ||
            !relayPromptId ||
            hasStartedContent ||
            pickupAttempted
          ) {
            return false;
          }
          pickupAttempted = true;
          const promptId = relayPromptId;
          let cancelled = false;

          if (placeholderMsg) renderError(placeholderMsg);
          set({
            _relayPollCancel: () => {
              cancelled = true;
            },
          });

          // The deadline keeps the poll bounded, but each batch of new cards
          // pushes it forward: a large import streams cards over several minutes
          // (one per ~25 rows), and an agent that is still actively delivering
          // should keep the browser polling rather than be abandoned mid-import.
          // The fresh window per batch stays under the server buffer TTL.
          let deadline = Date.now() + RELAY_PICKUP_DEADLINE_MS;
          const delay = (ms: number) =>
            new Promise<void>((resolve) => setTimeout(resolve, ms));

          void (async () => {
            // Poll immediately, then on each interval until answered/deadline.
            while (!cancelled && Date.now() < deadline) {
              try {
                const { text, pendingActions: latePending } =
                  await aiApi.getRelayResponse(promptId);
                // cancel()/clear()/a new prompt flips `cancelled`, so a late
                // answer never resurrects a turn the user has moved on from.
                if (cancelled) return;
                // Show any confirmation cards as soon as they arrive; the answer
                // (post_response) may still be a poll or two behind them.
                if (
                  latePending &&
                  latePending.length > 0 &&
                  deliverLateActions(latePending)
                ) {
                  deadline = Date.now() + RELAY_PICKUP_DEADLINE_MS;
                }
                if (text) {
                  deliverLateAnswer(text);
                  return;
                }
              } catch {
                // Transient (network/5xx) -- keep trying until the deadline.
              }
              await delay(RELAY_PICKUP_POLL_MS);
            }
            // Gave up. Drop the canceller handle; if no placeholder was shown
            // (silent backstop path) also stop the spinner.
            set((state) => ({
              _relayPollCancel: null,
              ...(placeholderMsg
                ? {}
                : state.isLoading
                  ? {
                      isLoading: false,
                      thinking: IDLE_THINKING,
                      _abortController: null,
                      _activeAssistantId: null,
                    }
                  : {}),
            }));
          })();

          return true;
        };

        // Build conversation history from existing messages for context.
        // Only include completed (non-streaming, non-error) messages with
        // actual content so the AI can reference prior turns.
        const fullHistory = get()
          .messages.filter(
            (m) =>
              !m.isStreaming &&
              !m.error &&
              m.content.length > 0,
          )
          .map((m) => ({ role: m.role, content: m.content }));
        // In relay mode, cap history so the user's agent isn't overwhelmed by an
        // ever-growing context; the native LLM path keeps the full history.
        const history = relay ? trimRelayHistory(fullHistory) : fullHistory;

        const controller = aiApi.queryStream(trimmed, {
          onEvent: (event: StreamEvent) => {
            switch (event.type) {
              case 'prompt_id':
                relayPromptId = event.promptId ?? null;
                break;

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
                  // Render the chart immediately, creating the assistant message
                  // if it arrived before any text content.
                  upsertAssistantMessage();
                }
                break;

              case 'pending_action':
                if (event.action) {
                  pendingActions.push({ ...event.action, status: 'pending' });
                  // Render the card immediately. In relay mode the agent posts
                  // cards before its final answer (post_response), so without
                  // this they would stay invisible until the answer arrives --
                  // and be lost entirely if the turn disconnects first (#793).
                  upsertAssistantMessage();
                }
                break;

              case 'content':
                if (!hasStartedContent) {
                  hasStartedContent = true;
                  set({ thinking: IDLE_THINKING });
                }
                contentBuffer = event.text || '';
                upsertAssistantMessage();
                break;

              case 'sources':
                sources =
                  (event.sources as ChatMessage['sources']) || [];
                break;

              case 'done':
                set((state) => {
                  const current = state.messages.find(
                    (m) => m.id === assistantMsgId,
                  );
                  const merged = projectPendingActions(current);
                  return {
                    messages: state.messages.map((m) =>
                      m.id === assistantMsgId
                        ? {
                            ...m,
                            isStreaming: false,
                            sources,
                            charts: charts.length > 0 ? [...charts] : m.charts,
                            pendingActions:
                              merged.length > 0 ? merged : m.pendingActions,
                          }
                        : m,
                    ),
                    isLoading: false,
                    thinking: IDLE_THINKING,
                    _abortController: null,
                    _activeAssistantId: null,
                  };
                });
                break;

              case 'error': {
                const errorMsg =
                  (event.message as string) || 'An error occurred';
                // For a relay timeout, the agent may still recover and post a
                // late answer. Show the disconnect message and keep polling for
                // it; only fall back to a hard error if this isn't a relay turn.
                if (!pollRelayPickup(errorMsg)) renderError(errorMsg);
                break;
              }
            }
          },
          onDone: () => {
            // Backstop in case the server closes without a 'done' event. If the
            // relay stream closed before an answer (no content, no error event),
            // poll for a late answer the agent may still buffer; otherwise just
            // stop the spinner.
            if (get().isLoading && !pollRelayPickup()) {
              set({
                isLoading: false,
                thinking: IDLE_THINKING,
                _abortController: null,
                _activeAssistantId: null,
              });
            }
          },
          onError: (error: Error) => {
            const errorMsg =
              error.message || 'Failed to connect to the AI service.';
            // A relay stream that errors mid-flight may still recover and post a
            // late answer; keep polling for it (placeholder shown) rather than
            // surfacing a hard error immediately.
            if (pollRelayPickup(errorMsg)) return;
            if (!hasStartedContent) {
              renderError(errorMsg);
              return;
            }
            set({
              isLoading: false,
              thinking: IDLE_THINKING,
              _abortController: null,
              _activeAssistantId: null,
            });
          },
        }, history, { relay }, attachments);

        set({ _abortController: controller });
      },

      cancel: () => {
        const { _abortController, _activeAssistantId, _relayPollCancel } = get();
        _abortController?.abort();
        _relayPollCancel?.();
        set((state) => ({
          isLoading: false,
          thinking: IDLE_THINKING,
          _abortController: null,
          _activeAssistantId: null,
          _relayPollCancel: null,
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
        get()._relayPollCancel?.();
        set({
          messages: [],
          isLoading: false,
          thinking: IDLE_THINKING,
          _abortController: null,
          _activeAssistantId: null,
          _relayPollCancel: null,
        });
      },

      confirmAction: async (messageId: string, actionId: string) => {
        const message = get().messages.find((m) => m.id === messageId);
        const action = message?.pendingActions?.find(
          (a) => a.actionId === actionId,
        );
        // Guard against double-submit: only a pending action (or one that
        // previously errored, for retry) is sendable.
        if (!action || (action.status !== 'pending' && action.status !== 'error'))
          return;

        set((state) => ({
          messages: patchPendingAction(state.messages, messageId, actionId, {
            status: 'confirming',
          }),
        }));

        try {
          const res = await aiApi.confirmAction({
            actionId: action.actionId,
            signature: action.signature,
            descriptor: action.descriptor,
          });
          set((state) => ({
            messages: patchPendingAction(state.messages, messageId, actionId, {
              status: 'confirmed',
              resultId: res.id,
              resultCount: res.count,
              resultSkipped: res.skipped,
            }),
          }));
          // The write landed server-side; tell any mounted list page to reload
          // so the new/edited record shows up without a manual refresh (e.g. a
          // transaction created from the chat bubble while on the Transactions
          // page).
          notifyAiAction();
        } catch (err) {
          const errorMessage =
            (err as { response?: { data?: { message?: string } } })?.response
              ?.data?.message ||
            (err as Error)?.message ||
            'error';
          set((state) => ({
            messages: patchPendingAction(state.messages, messageId, actionId, {
              status: 'error',
              errorMessage,
            }),
          }));
        }
      },

      cancelAction: (messageId: string, actionId: string) => {
        const message = get().messages.find((m) => m.id === messageId);
        const action = message?.pendingActions?.find(
          (a) => a.actionId === actionId,
        );
        if (!action || action.status !== 'pending') return;
        set((state) => ({
          messages: patchPendingAction(state.messages, messageId, actionId, {
            status: 'cancelled',
          }),
        }));
      },

      _heal: () => {
        set((state) => {
          // After rehydration, no stream is actually running — the abort
          // controller from the previous tab/page is gone. Any persisted
          // isStreaming flag is stale, and any still-pending action card refers
          // to a signature whose window may have closed, so mark it expired so
          // a reloaded card cannot be confirmed against a stale signature.
          const needsHeal = state.messages.some(
            (m) =>
              m.isStreaming ||
              m.pendingActions?.some(
                (a) => a.status === 'pending' || a.status === 'confirming',
              ),
          );
          if (!needsHeal) return {};
          return {
            messages: state.messages.map((m) => ({
              ...m,
              isStreaming: m.isStreaming ? false : m.isStreaming,
              pendingActions: m.pendingActions?.map((a) =>
                a.status === 'pending' || a.status === 'confirming'
                  ? { ...a, status: 'expired' as const }
                  : a,
              ),
            })),
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
