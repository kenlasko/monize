import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/render';
import { ChatInterface } from './ChatInterface';
import type { StreamCallbacks } from '@/types/ai';

// Capture the callbacks from queryStream calls
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

// jsdom doesn't implement scrollIntoView
Element.prototype.scrollIntoView = vi.fn();

describe('ChatInterface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedCallbacks = null;
  });

  it('shows suggested queries when no messages', () => {
    render(<ChatInterface />);
    expect(screen.getByText('Ask about your finances')).toBeInTheDocument();
  });

  it('renders the input textarea', () => {
    render(<ChatInterface />);
    expect(
      screen.getByPlaceholderText('Ask about your finances...'),
    ).toBeInTheDocument();
  });

  it('renders the send button', () => {
    render(<ChatInterface />);
    expect(screen.getByTitle('Send')).toBeInTheDocument();
  });

  it('shows helper text for keyboard shortcuts', () => {
    render(<ChatInterface />);
    expect(
      screen.getByText('Press Enter to send, Shift+Enter for new line'),
    ).toBeInTheDocument();
  });

  it('disables send button when input is empty', () => {
    render(<ChatInterface />);
    const sendButton = screen.getByTitle('Send');
    expect(sendButton).toBeDisabled();
  });

  it('enables send button when input has text', () => {
    render(<ChatInterface />);
    const textarea = screen.getByPlaceholderText(
      'Ask about your finances...',
    );
    fireEvent.change(textarea, { target: { value: 'My balance?' } });

    const sendButton = screen.getByTitle('Send');
    expect(sendButton).not.toBeDisabled();
  });

  it('submits query when send button is clicked', async () => {
    const { aiApi } = await import('@/lib/ai');
    render(<ChatInterface />);

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
    render(<ChatInterface />);

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
    render(<ChatInterface />);

    const textarea = screen.getByPlaceholderText(
      'Ask about your finances...',
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: { value: 'How much did I spend?' },
    });
    fireEvent.click(screen.getByTitle('Send'));

    expect(textarea.value).toBe('');
  });

  it('hides suggested queries after first message', () => {
    render(<ChatInterface />);

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

  it('shows thinking indicator while loading', () => {
    render(<ChatInterface />);

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

  it('shows cancel button while loading', () => {
    render(<ChatInterface />);

    const textarea = screen.getByPlaceholderText(
      'Ask about your finances...',
    );
    fireEvent.change(textarea, {
      target: { value: 'Test' },
    });
    fireEvent.click(screen.getByTitle('Send'));

    expect(screen.getByTitle('Cancel')).toBeInTheDocument();
  });

  it('aborts request when cancel is clicked', () => {
    render(<ChatInterface />);

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

  it('disables textarea while loading', () => {
    render(<ChatInterface />);

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
    render(<ChatInterface />);

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
    render(<ChatInterface />);

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
    render(<ChatInterface />);

    fireEvent.click(screen.getByText('Monthly spending'));

    expect(aiApi.queryStream).toHaveBeenCalledWith(
      'How much did I spend last month?',
      expect.any(Object),
    );
  });

  describe('stream event handling', () => {
    it('shows content from content events', async () => {
      render(<ChatInterface />);

      const textarea = screen.getByPlaceholderText(
        'Ask about your finances...',
      );
      fireEvent.change(textarea, {
        target: { value: 'Test' },
      });
      fireEvent.click(screen.getByTitle('Send'));

      // Simulate content event
      capturedCallbacks?.onEvent({ type: 'content', text: 'Your balance is $5,000.' });

      await waitFor(() => {
        expect(
          screen.getByText('Your balance is $5,000.'),
        ).toBeInTheDocument();
      });
    });

    it('shows tool progress in thinking indicator', async () => {
      render(<ChatInterface />);

      const textarea = screen.getByPlaceholderText(
        'Ask about your finances...',
      );
      fireEvent.change(textarea, {
        target: { value: 'Test' },
      });
      fireEvent.click(screen.getByTitle('Send'));

      // Simulate tool_start event
      capturedCallbacks?.onEvent({
        type: 'tool_start',
        name: 'get_account_balances',
      });

      await waitFor(() => {
        expect(
          screen.getByText(/Looking up get account balances/),
        ).toBeInTheDocument();
      });
    });

    it('shows error message from error events', async () => {
      render(<ChatInterface />);

      const textarea = screen.getByPlaceholderText(
        'Ask about your finances...',
      );
      fireEvent.change(textarea, {
        target: { value: 'Test' },
      });
      fireEvent.click(screen.getByTitle('Send'));

      capturedCallbacks?.onEvent({
        type: 'error',
        message: 'No AI provider configured',
      });

      await waitFor(() => {
        expect(
          screen.getByText('No AI provider configured'),
        ).toBeInTheDocument();
      });
    });

    it('finishes loading after done event', async () => {
      render(<ChatInterface />);

      const textarea = screen.getByPlaceholderText(
        'Ask about your finances...',
      );
      fireEvent.change(textarea, {
        target: { value: 'Test' },
      });
      fireEvent.click(screen.getByTitle('Send'));

      capturedCallbacks?.onEvent({ type: 'content', text: 'Answer.' });
      capturedCallbacks?.onEvent({
        type: 'done',
        usage: { inputTokens: 100, outputTokens: 50, toolCalls: 0 },
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
    render(<ChatInterface />);

    const textarea = screen.getByPlaceholderText(
      'Ask about your finances...',
    );
    fireEvent.change(textarea, { target: { value: '   ' } });
    fireEvent.click(screen.getByTitle('Send'));

    expect(aiApi.queryStream).not.toHaveBeenCalled();
  });
});
