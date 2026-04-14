import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { ChatInterface, AI_CHAT_STORAGE_KEY } from './ChatInterface';
import type { StreamCallbacks } from '@/types/ai';

// Capture the callbacks from queryStream calls
let capturedCallbacks: StreamCallbacks | null = null;
const mockAbortController = { abort: vi.fn() };

vi.mock('@/lib/ai', () => ({
  aiApi: {
    getStatus: vi.fn().mockResolvedValue({ configured: true }),
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
    // Chat now persists to localStorage. The test setup's mock is shared across
    // tests, so clear the key to prevent messages from one test bleeding into
    // the next.
    window.localStorage.removeItem(AI_CHAT_STORAGE_KEY);
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

    expect(aiApi.queryStream).toHaveBeenCalledWith(
      'How much did I spend?',
      expect.any(Object),
    );
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

    expect(aiApi.queryStream).toHaveBeenCalledWith(
      'Balance?',
      expect.any(Object),
    );
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

    expect(aiApi.queryStream).toHaveBeenCalledWith(
      'How much did I spend last month?',
      expect.any(Object),
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
    it('restores prior conversation from localStorage on mount', async () => {
      window.localStorage.setItem(
        AI_CHAT_STORAGE_KEY,
        JSON.stringify([
          { id: 'user-1', role: 'user', content: 'What did I spend?' },
          { id: 'assistant-1', role: 'assistant', content: 'You spent $42.' },
        ]),
      );

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

      const stored = window.localStorage.getItem(AI_CHAT_STORAGE_KEY);
      expect(stored).not.toBeNull();
      const parsed = JSON.parse(stored as string);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toMatchObject({ role: 'user', content: 'Balance?' });
    });

    it('heals stuck isStreaming flag from an interrupted session', async () => {
      window.localStorage.setItem(
        AI_CHAT_STORAGE_KEY,
        JSON.stringify([
          { id: 'user-1', role: 'user', content: 'Q' },
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Partial answer',
            isStreaming: true,
          },
        ]),
      );

      await renderChat();

      // The "Send" button is shown (not the in-flight "Cancel" button),
      // confirming the restored state isn't treated as an active request.
      expect(screen.getByTitle('Send')).toBeInTheDocument();
      expect(screen.queryByTitle('Cancel')).not.toBeInTheDocument();

      const stored = JSON.parse(
        window.localStorage.getItem(AI_CHAT_STORAGE_KEY) as string,
      );
      expect(stored[1].isStreaming).toBe(false);
    });

    it('clears the conversation when Clear conversation is clicked', async () => {
      window.localStorage.setItem(
        AI_CHAT_STORAGE_KEY,
        JSON.stringify([
          { id: 'user-1', role: 'user', content: 'Hello' },
          { id: 'assistant-1', role: 'assistant', content: 'Hi there' },
        ]),
      );

      await renderChat();
      expect(screen.getByText('Hello')).toBeInTheDocument();

      fireEvent.click(screen.getByText('Clear conversation'));

      expect(screen.queryByText('Hello')).not.toBeInTheDocument();
      expect(screen.queryByText('Hi there')).not.toBeInTheDocument();
      const stored = JSON.parse(
        window.localStorage.getItem(AI_CHAT_STORAGE_KEY) as string,
      );
      expect(stored).toEqual([]);
    });

    it('does not show the conversation header when there are no messages', async () => {
      await renderChat();
      expect(
        screen.queryByText('Conversation saved in your browser'),
      ).not.toBeInTheDocument();
      expect(screen.queryByText('Clear conversation')).not.toBeInTheDocument();
    });
  });
});
