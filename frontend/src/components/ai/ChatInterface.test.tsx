import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { ChatInterface, AI_CHAT_STORAGE_KEY } from './ChatInterface';
import { useAiChatStore, type ChatMessage } from '@/store/aiChatStore';
import type { StreamCallbacks } from '@/types/ai';

// The Zustand persist middleware wraps state as { state: {...}, version: 0 }.
// Helpers let tests seed and inspect the persisted blob without mirroring that
// shape inline everywhere.
function seedPersistedMessages(messages: ChatMessage[]) {
  window.localStorage.setItem(
    AI_CHAT_STORAGE_KEY,
    JSON.stringify({ state: { messages }, version: 0 }),
  );
  // Push the same messages into the live store so the component renders them
  // without waiting for rehydration on a remounted store.
  useAiChatStore.setState({ messages });
}

function readPersistedMessages(): ChatMessage[] | null {
  const raw = window.localStorage.getItem(AI_CHAT_STORAGE_KEY);
  if (!raw) return null;
  return JSON.parse(raw).state.messages;
}

// Capture the callbacks from queryStream calls
let capturedCallbacks: StreamCallbacks | null = null;
const mockAbortController = { abort: vi.fn() };

vi.mock('@/lib/ai', () => ({
  aiApi: {
    getStatus: vi.fn().mockResolvedValue({ configured: true }),
    getRelayStatus: vi
      .fn()
      .mockResolvedValue({ state: 'listening', queued: 0 }),
    queryStream: vi.fn((_query: string, callbacks: StreamCallbacks) => {
      capturedCallbacks = callbacks;
      return mockAbortController;
    }),
  },
}));

// jsdom doesn't implement scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

// Render and flush all pending async state updates (e.g. useEffect API calls)
async function renderChat() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<ChatInterface />);
  });
  return result!;
}

describe('ChatInterface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedCallbacks = null;
    // Chat state lives in a Zustand store that survives across tests (singleton)
    // and persists to a shared localStorage mock — reset both so messages from
    // one test don't bleed into the next.
    window.localStorage.removeItem(AI_CHAT_STORAGE_KEY);
    useAiChatStore.setState({
      messages: [],
      isLoading: false,
      thinking: { active: false, message: '', liveText: '', tools: [] },
      _abortController: null,
      _activeAssistantId: null,
    });
  });

  it('shows suggested queries when no messages', async () => {
    await renderChat();
    expect(screen.getByText('Ask about your finances')).toBeInTheDocument();
  });

  it('renders the input textarea', async () => {
    await renderChat();
    expect(
      screen.getByPlaceholderText('Ask about your finances...'),
    ).toBeInTheDocument();
  });

  it('renders the send button', async () => {
    await renderChat();
    expect(screen.getByTitle('Send')).toBeInTheDocument();
  });

  it('shows helper text for keyboard shortcuts', async () => {
    await renderChat();
    expect(
      screen.getByText('Press Enter to send, Shift+Enter for new line'),
    ).toBeInTheDocument();
  });

  it('disables send button when input is empty', async () => {
    await renderChat();
    const sendButton = screen.getByTitle('Send');
    expect(sendButton).toBeDisabled();
  });

  it('enables send button when input has text', async () => {
    await renderChat();
    const textarea = screen.getByPlaceholderText(
      'Ask about your finances...',
    );
    fireEvent.change(textarea, { target: { value: 'My balance?' } });

    const sendButton = screen.getByTitle('Send');
    expect(sendButton).not.toBeDisabled();
  });

  it('submits query when send button is clicked', async () => {
    const { aiApi } = await import('@/lib/ai');
    await renderChat();

    const textarea = screen.getByPlaceholderText(
      'Ask about your finances...',
    );
    fireEvent.change(textarea, {
      target: { value: 'How much did I spend?' },
    });

    fireEvent.click(screen.getByTitle('Send'));

    expect(aiApi.queryStream).toHaveBeenCalledTimes(1);
    const call = vi.mocked(aiApi.queryStream).mock.calls[0];
    expect(call[0]).toBe('How much did I spend?');
    expect(call[1]).toEqual(expect.objectContaining({
      onEvent: expect.any(Function),
    }));
  });

  it('adds user message to the list on submit', async () => {
    await renderChat();

    const textarea = screen.getByPlaceholderText(
      'Ask about your finances...',
    );
    fireEvent.change(textarea, {
      target: { value: 'My balance?' },
    });
    fireEvent.click(screen.getByTitle('Send'));

    expect(screen.getByText('My balance?')).toBeInTheDocument();
  });

  it('clears input after submit', async () => {
    await renderChat();

    const textarea = screen.getByPlaceholderText(
      'Ask about your finances...',
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: { value: 'How much did I spend?' },
    });
    fireEvent.click(screen.getByTitle('Send'));

    expect(textarea.value).toBe('');
  });

  it('hides suggested queries after first message', async () => {
    await renderChat();

    const textarea = screen.getByPlaceholderText(
      'Ask about your finances...',
    );
    fireEvent.change(textarea, {
      target: { value: 'Test query' },
    });
    fireEvent.click(screen.getByTitle('Send'));

    expect(
      screen.queryByText('Ask about your finances'),
    ).not.toBeInTheDocument();
  });

  it('shows thinking indicator while loading', async () => {
    await renderChat();

    const textarea = screen.getByPlaceholderText(
      'Ask about your finances...',
    );
    fireEvent.change(textarea, {
      target: { value: 'Test' },
    });
    fireEvent.click(screen.getByTitle('Send'));

    expect(
      screen.getByText('Analyzing your question...'),
    ).toBeInTheDocument();
  });

  it('shows cancel button while loading', async () => {
    await renderChat();

    const textarea = screen.getByPlaceholderText(
      'Ask about your finances...',
    );
    fireEvent.change(textarea, {
      target: { value: 'Test' },
    });
    fireEvent.click(screen.getByTitle('Send'));

    expect(screen.getByTitle('Cancel')).toBeInTheDocument();
  });

  it('aborts request when cancel is clicked', async () => {
    await renderChat();

    const textarea = screen.getByPlaceholderText(
      'Ask about your finances...',
    );
    fireEvent.change(textarea, {
      target: { value: 'Test' },
    });
    fireEvent.click(screen.getByTitle('Send'));

    fireEvent.click(screen.getByTitle('Cancel'));

    expect(mockAbortController.abort).toHaveBeenCalled();
  });

  it('disables textarea while loading', async () => {
    await renderChat();

    const textarea = screen.getByPlaceholderText(
      'Ask about your finances...',
    );
    fireEvent.change(textarea, {
      target: { value: 'Test' },
    });
    fireEvent.click(screen.getByTitle('Send'));

    expect(textarea).toBeDisabled();
  });

  it('submits on Enter key', async () => {
    const { aiApi } = await import('@/lib/ai');
    await renderChat();

    const textarea = screen.getByPlaceholderText(
      'Ask about your finances...',
    );
    fireEvent.change(textarea, {
      target: { value: 'Balance?' },
    });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(aiApi.queryStream).toHaveBeenCalledTimes(1);
    expect(vi.mocked(aiApi.queryStream).mock.calls[0][0]).toBe('Balance?');
  });

  it('does not submit on Shift+Enter', async () => {
    const { aiApi } = await import('@/lib/ai');
    await renderChat();

    const textarea = screen.getByPlaceholderText(
      'Ask about your finances...',
    );
    fireEvent.change(textarea, {
      target: { value: 'Test' },
    });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

    expect(aiApi.queryStream).not.toHaveBeenCalled();
  });

  it('submits when a suggested query is clicked', async () => {
    const { aiApi } = await import('@/lib/ai');
    await renderChat();

    fireEvent.click(screen.getByText('Monthly spending'));

    expect(aiApi.queryStream).toHaveBeenCalledTimes(1);
    expect(vi.mocked(aiApi.queryStream).mock.calls[0][0]).toBe(
      'How much did I spend last month?',
    );
  });

  describe('stream event handling', () => {
    it('shows content from content events', async () => {
      await renderChat();

      const textarea = screen.getByPlaceholderText(
        'Ask about your finances...',
      );
      fireEvent.change(textarea, {
        target: { value: 'Test' },
      });
      fireEvent.click(screen.getByTitle('Send'));

      // Simulate content event
      act(() => {
        capturedCallbacks?.onEvent({ type: 'content', text: 'Your balance is $5,000.' });
      });

      await waitFor(() => {
        expect(
          screen.getByText('Your balance is $5,000.'),
        ).toBeInTheDocument();
      });
    });

    it('shows tool progress in thinking indicator', async () => {
      await renderChat();

      const textarea = screen.getByPlaceholderText(
        'Ask about your finances...',
      );
      fireEvent.change(textarea, {
        target: { value: 'Test' },
      });
      fireEvent.click(screen.getByTitle('Send'));

      // Simulate tool_start event
      act(() => {
        capturedCallbacks?.onEvent({
          type: 'tool_start',
          name: 'get_account_balances',
        });
      });

      await waitFor(() => {
        expect(
          screen.getByText(/Looking up get account balances/),
        ).toBeInTheDocument();
      });
    });

    it('shows error message from error events', async () => {
      await renderChat();

      const textarea = screen.getByPlaceholderText(
        'Ask about your finances...',
      );
      fireEvent.change(textarea, {
        target: { value: 'Test' },
      });
      fireEvent.click(screen.getByTitle('Send'));

      act(() => {
        capturedCallbacks?.onEvent({
          type: 'error',
          message: 'No AI provider configured',
        });
      });

      await waitFor(() => {
        expect(
          screen.getByText('No AI provider configured'),
        ).toBeInTheDocument();
      });
    });

    it('shows live streamed text from assistant_text events in the thinking panel', async () => {
      await renderChat();

      const textarea = screen.getByPlaceholderText(
        'Ask about your finances...',
      );
      fireEvent.change(textarea, { target: { value: 'Test' } });
      fireEvent.click(screen.getByTitle('Send'));

      // Simulate three text deltas streaming in
      act(() => {
        capturedCallbacks?.onEvent({ type: 'assistant_text', text: 'Looking ' });
      });
      act(() => {
        capturedCallbacks?.onEvent({ type: 'assistant_text', text: 'at ' });
      });
      act(() => {
        capturedCallbacks?.onEvent({
          type: 'assistant_text',
          text: 'your accounts.',
        });
      });

      await waitFor(() => {
        // Live thinking text accumulates the deltas
        expect(
          screen.getByText('Looking at your accounts.'),
        ).toBeInTheDocument();
      });
    });

    it('clears the live thinking text when a new tool_start fires', async () => {
      await renderChat();

      const textarea = screen.getByPlaceholderText(
        'Ask about your finances...',
      );
      fireEvent.change(textarea, { target: { value: 'Test' } });
      fireEvent.click(screen.getByTitle('Send'));

      act(() => {
        capturedCallbacks?.onEvent({
          type: 'assistant_text',
          text: 'I will check the database.',
        });
      });

      await waitFor(() => {
        expect(
          screen.getByText('I will check the database.'),
        ).toBeInTheDocument();
      });

      // Tool start should reset the live text buffer for the next iteration
      act(() => {
        capturedCallbacks?.onEvent({
          type: 'tool_start',
          name: 'get_account_balances',
        });
      });

      await waitFor(() => {
        expect(
          screen.queryByText('I will check the database.'),
        ).not.toBeInTheDocument();
      });
    });

    it('promotes streamed text to a finalized message bubble on content event', async () => {
      await renderChat();

      const textarea = screen.getByPlaceholderText(
        'Ask about your finances...',
      );
      fireEvent.change(textarea, { target: { value: 'Test' } });
      fireEvent.click(screen.getByTitle('Send'));

      act(() => {
        capturedCallbacks?.onEvent({
          type: 'assistant_text',
          text: 'Your balance is $5,000.',
        });
      });

      // The streamed text appears live in the thinking panel
      await waitFor(() => {
        expect(
          screen.getByText('Your balance is $5,000.'),
        ).toBeInTheDocument();
      });

      // The final content event finalizes it; the same text now lives in
      // the proper assistant message bubble (still in the document).
      act(() => {
        capturedCallbacks?.onEvent({
          type: 'content',
          text: 'Your balance is $5,000.',
        });
      });

      await waitFor(() => {
        expect(
          screen.getByText('Your balance is $5,000.'),
        ).toBeInTheDocument();
      });
    });

    it('finishes loading after done event', async () => {
      await renderChat();

      const textarea = screen.getByPlaceholderText(
        'Ask about your finances...',
      );
      fireEvent.change(textarea, {
        target: { value: 'Test' },
      });
      fireEvent.click(screen.getByTitle('Send'));

      act(() => {
        capturedCallbacks?.onEvent({ type: 'content', text: 'Answer.' });
        capturedCallbacks?.onEvent({
          type: 'done',
          usage: { inputTokens: 100, outputTokens: 50, toolCalls: 0 },
        });
      });

      await waitFor(() => {
        // Should show send button again, not cancel
        expect(screen.getByTitle('Send')).toBeInTheDocument();
        expect(screen.queryByTitle('Cancel')).not.toBeInTheDocument();
      });
    });
  });

  it('does not submit empty or whitespace-only input', async () => {
    const { aiApi } = await import('@/lib/ai');
    await renderChat();

    const textarea = screen.getByPlaceholderText(
      'Ask about your finances...',
    );
    fireEvent.change(textarea, { target: { value: '   ' } });
    fireEvent.click(screen.getByTitle('Send'));

    expect(aiApi.queryStream).not.toHaveBeenCalled();
  });

  describe('conversation persistence', () => {
    it('restores prior conversation from the store on mount', async () => {
      seedPersistedMessages([
        { id: 'user-1', role: 'user', content: 'What did I spend?' },
        { id: 'assistant-1', role: 'assistant', content: 'You spent $42.' },
      ]);

      await renderChat();

      expect(screen.getByText('What did I spend?')).toBeInTheDocument();
      expect(screen.getByText('You spent $42.')).toBeInTheDocument();
    });

    it('persists new messages to localStorage', async () => {
      await renderChat();

      const textarea = screen.getByPlaceholderText(
        'Ask about your finances...',
      );
      fireEvent.change(textarea, { target: { value: 'Balance?' } });
      fireEvent.click(screen.getByTitle('Send'));

      const stored = readPersistedMessages();
      expect(stored).not.toBeNull();
      expect(stored).toHaveLength(1);
      expect(stored?.[0]).toMatchObject({ role: 'user', content: 'Balance?' });
    });

    it('keeps streaming into the store after the component unmounts', async () => {
      // Simulates the user navigating away mid-query. The store keeps writing
      // to messages and localStorage even with no component subscribed, so
      // when they return the assistant response is fully there.
      const { unmount } = await renderChat();

      const textarea = screen.getByPlaceholderText(
        'Ask about your finances...',
      );
      fireEvent.change(textarea, { target: { value: 'Q' } });
      fireEvent.click(screen.getByTitle('Send'));

      // User leaves the AI page
      unmount();

      // Stream completes in the background
      act(() => {
        capturedCallbacks?.onEvent({
          type: 'content',
          text: 'Backgrounded answer.',
        });
        capturedCallbacks?.onEvent({
          type: 'done',
          usage: { inputTokens: 10, outputTokens: 5, toolCalls: 0 },
        });
      });

      const stored = readPersistedMessages();
      expect(stored).toHaveLength(2);
      expect(stored?.[1]).toMatchObject({
        role: 'assistant',
        content: 'Backgrounded answer.',
        isStreaming: false,
      });

      // User returns to the AI page — the answer is shown, no spinner.
      await renderChat();
      expect(screen.getByText('Backgrounded answer.')).toBeInTheDocument();
      expect(screen.getByTitle('Send')).toBeInTheDocument();
      expect(screen.queryByTitle('Cancel')).not.toBeInTheDocument();
    });

    it('heals stuck isStreaming flag from an interrupted session', async () => {
      // Simulate a previous tab that was killed mid-stream — the Zustand
      // persist middleware would have written messages with isStreaming:true.
      window.localStorage.setItem(
        AI_CHAT_STORAGE_KEY,
        JSON.stringify({
          state: {
            messages: [
              { id: 'user-1', role: 'user', content: 'Q' },
              {
                id: 'assistant-1',
                role: 'assistant',
                content: 'Partial answer',
                isStreaming: true,
              },
            ],
          },
          version: 0,
        }),
      );
      // Force the store to rehydrate from the seeded payload.
      await useAiChatStore.persist.rehydrate();

      await renderChat();

      // Send button (not Cancel) confirms the restored state isn't treated
      // as an in-flight request.
      expect(screen.getByTitle('Send')).toBeInTheDocument();
      expect(screen.queryByTitle('Cancel')).not.toBeInTheDocument();

      const stored = readPersistedMessages();
      expect(stored?.[1].isStreaming).toBe(false);
    });

    it('clears the conversation when Clear conversation is clicked', async () => {
      seedPersistedMessages([
        { id: 'user-1', role: 'user', content: 'Hello' },
        { id: 'assistant-1', role: 'assistant', content: 'Hi there' },
      ]);

      await renderChat();
      expect(screen.getByText('Hello')).toBeInTheDocument();

      fireEvent.click(screen.getByText('Clear conversation'));

      expect(screen.queryByText('Hello')).not.toBeInTheDocument();
      expect(screen.queryByText('Hi there')).not.toBeInTheDocument();
      expect(readPersistedMessages()).toEqual([]);
    });

    it('does not show the conversation header when there are no messages', async () => {
      await renderChat();
      expect(
        screen.queryByText('Conversation saved in your browser'),
      ).not.toBeInTheDocument();
      expect(screen.queryByText('Clear conversation')).not.toBeInTheDocument();
    });
  });

  describe('attachments', () => {
    beforeEach(() => {
      // jsdom doesn't implement object URLs; image previews need them.
      URL.createObjectURL = vi.fn(() => 'blob:mock');
      URL.revokeObjectURL = vi.fn();
    });

    function fileInputOf(container: HTMLElement): HTMLInputElement {
      return container.querySelector('input[type="file"]') as HTMLInputElement;
    }

    const pngFile = () =>
      new File([new Uint8Array([1, 2, 3])], 'receipt.png', { type: 'image/png' });

    it('attaches a selected file and shows a removable chip', async () => {
      const { container } = await renderChat();

      await act(async () => {
        fireEvent.change(fileInputOf(container), {
          target: { files: [pngFile()] },
        });
      });

      await waitFor(() =>
        expect(screen.getByText('receipt.png')).toBeInTheDocument(),
      );

      fireEvent.click(screen.getByLabelText('Remove attachment'));
      await waitFor(() =>
        expect(screen.queryByText('receipt.png')).not.toBeInTheDocument(),
      );
    });

    it('enables send with an attachment but no typed text', async () => {
      const { container } = await renderChat();
      expect(screen.getByTitle('Send')).toBeDisabled();

      await act(async () => {
        fireEvent.change(fileInputOf(container), {
          target: { files: [pngFile()] },
        });
      });

      await waitFor(() =>
        expect(screen.getByText('receipt.png')).toBeInTheDocument(),
      );
      expect(screen.getByTitle('Send')).not.toBeDisabled();
    });

    it('submits the base64 payload and clears chips on send', async () => {
      const { aiApi } = await import('@/lib/ai');
      const { container } = await renderChat();

      await act(async () => {
        fireEvent.change(fileInputOf(container), {
          target: { files: [pngFile()] },
        });
      });
      await waitFor(() =>
        expect(screen.getByText('receipt.png')).toBeInTheDocument(),
      );

      const textarea = screen.getByPlaceholderText('Ask about your finances...');
      fireEvent.change(textarea, { target: { value: 'extract this' } });
      await act(async () => {
        fireEvent.click(screen.getByTitle('Send'));
      });

      const call = vi.mocked(aiApi.queryStream).mock.calls[0];
      expect(call[0]).toBe('extract this');
      // 5th arg is the attachment payload; bytes [1,2,3] base64-encode to "AQID".
      expect(call[4]).toEqual([
        { kind: 'image', mediaType: 'image/png', filename: 'receipt.png', data: 'AQID' },
      ]);

      // The composer chip (with its remove button) clears; the filename still
      // shows on the sent message bubble, so assert via the remove control.
      await waitFor(() =>
        expect(
          screen.queryByLabelText('Remove attachment'),
        ).not.toBeInTheDocument(),
      );
    });

    it('attaches an image pasted from the clipboard', async () => {
      const { container } = await renderChat();
      const textarea = screen.getByPlaceholderText('Ask about your finances...');
      const file = new File([new Uint8Array([1, 2, 3])], 'pasted.png', {
        type: 'image/png',
      });

      await act(async () => {
        fireEvent.paste(textarea, {
          clipboardData: {
            items: [{ kind: 'file', getAsFile: () => file }],
            getData: () => '',
          },
        });
      });

      await waitFor(() =>
        expect(screen.getByText('pasted.png')).toBeInTheDocument(),
      );
      // The container is referenced to keep the file-input query consistent.
      expect(fileInputOf(container)).toBeInTheDocument();
    });

    it('allows attachments when relay is active and sends them on the relay path', async () => {
      const { aiApi } = await import('@/lib/ai');
      vi.mocked(aiApi.getStatus).mockResolvedValueOnce({
        configured: true,
        relayActive: true,
      } as never);

      const { container } = await renderChat();
      // The attach button stays available in relay mode.
      expect(screen.getByLabelText('Add attachment')).toBeInTheDocument();

      await act(async () => {
        fireEvent.change(fileInputOf(container), {
          target: { files: [pngFile()] },
        });
      });
      await waitFor(() =>
        expect(screen.getByText('receipt.png')).toBeInTheDocument(),
      );

      const textarea = screen.getByPlaceholderText('Ask about your finances...');
      fireEvent.change(textarea, { target: { value: 'read this' } });
      await act(async () => {
        fireEvent.click(screen.getByTitle('Send'));
      });

      const call = vi.mocked(aiApi.queryStream).mock.calls[0];
      // opts (4th arg) carries relay:true; attachments (5th arg) ride along.
      expect(call[3]).toMatchObject({ relay: true });
      expect(call[4]).toEqual([
        { kind: 'image', mediaType: 'image/png', filename: 'receipt.png', data: 'AQID' },
      ]);
    });
  });
});
